import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { db } from "../../db";
import { otpCodes, users } from "../../db/schema";
import {
  ACCESS_COOKIE,
  authPlugin,
  buildAuthUser,
  cookieOptions,
  issueTokens,
  REFRESH_COOKIE,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from "../../lib/auth";
import { badRequest, conflict, unauthorized } from "../../lib/errors";
import { notifyLater, sendEmail, sendSms } from "../../lib/notify";
import { sha256 } from "../../lib/utils";

const ACCESS_MAX_AGE = 15 * 60;
const REFRESH_MAX_AGE = env.refreshTokenTtlDays * 86_400;

const normalizePhone = (p: string) => {
  const digits = p.replace(/\D/g, "");
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
};
const isEmail = (s: string) => s.includes("@");

export const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  avatarUrl: u.avatarUrl,
  mustChangePassword: u.mustChangePassword,
});

export const authModule = new Elysia({ prefix: "/auth", tags: ["Auth"] })
  .use(authPlugin)
  .decorate("startSession", async function startSession(
    this: unknown,
    userId: string,
    cookie: Record<string, any>,
    meta: { userAgent?: string; ip?: string },
  ) {
    const authUser = await buildAuthUser(userId);
    const tokens = await issueTokens(authUser, meta);
    cookie[ACCESS_COOKIE].set({ value: tokens.accessToken, ...cookieOptions(ACCESS_MAX_AGE) });
    cookie[REFRESH_COOKIE].set({ value: tokens.refreshToken, ...cookieOptions(REFRESH_MAX_AGE) });
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    return { user: publicUser(user!), partnerId: authUser.partnerId, accessToken: tokens.accessToken };
  })

  // Email/phone + password (admins, partners, customers who set a password)
  .post(
    "/login",
    async ({ body, cookie, headers, server, request, startSession }) => {
      const id = body.identifier.trim();
      const user = await db.query.users.findFirst({
        where: isEmail(id)
          ? sql`lower(${users.email}) = ${id.toLowerCase()}`
          : eq(users.phone, normalizePhone(id)),
      });
      if (!user?.passwordHash || !(await Bun.password.verify(body.password, user.passwordHash)))
        throw unauthorized("Incorrect email/phone or password");
      if (!user.isActive) throw unauthorized("Account is disabled");
      if (body.portal === "admin" && !["SUPER_ADMIN", "ADMIN_STAFF"].includes(user.role))
        throw unauthorized("This account cannot access the admin panel");
      if (body.portal === "partner" && !["PARTNER_OWNER", "PARTNER_STAFF"].includes(user.role))
        throw unauthorized("This account cannot access the partner panel");
      return startSession(user.id, cookie, {
        userAgent: headers["user-agent"],
        ip: server?.requestIP(request)?.address,
      });
    },
    {
      body: t.Object({
        identifier: t.String({ minLength: 3 }),
        password: t.String({ minLength: 1 }),
        portal: t.Optional(t.Union([t.Literal("admin"), t.Literal("partner"), t.Literal("web")])),
      }),
    },
  )

  // Customer signup with password
  .post(
    "/register",
    async ({ body, cookie, headers, startSession }) => {
      const email = body.email.trim().toLowerCase();
      const phone = body.phone ? normalizePhone(body.phone) : null;
      const existing = await db.query.users.findFirst({
        where: or(sql`lower(${users.email}) = ${email}`, phone ? eq(users.phone, phone) : undefined),
      });
      if (existing) throw conflict("An account with this email or phone already exists");
      const [user] = await db
        .insert(users)
        .values({
          name: body.name.trim(),
          email,
          phone,
          passwordHash: await Bun.password.hash(body.password),
          role: "CUSTOMER",
        })
        .returning();
      return startSession(user.id, cookie, { userAgent: headers["user-agent"] });
    },
    {
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 160 }),
        email: t.String({ format: "email" }),
        phone: t.Optional(t.String({ minLength: 10, maxLength: 15 })),
        password: t.String({ minLength: 8 }),
      }),
    },
  )

  // OTP login/signup for guests (phone or email)
  .post(
    "/otp/request",
    async ({ body }) => {
      const target = isEmail(body.target) ? body.target.trim().toLowerCase() : normalizePhone(body.target);
      const recent = await db.query.otpCodes.findFirst({
        where: and(eq(otpCodes.target, target), gt(otpCodes.createdAt, new Date(Date.now() - 30_000))),
      });
      if (recent) throw badRequest("Please wait 30 seconds before requesting another code");
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await db.insert(otpCodes).values({
        target,
        codeHash: sha256(code),
        purpose: "LOGIN",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      const message = `${code} is your BookMeStays verification code. It expires in 10 minutes.`;
      notifyLater(
        isEmail(target)
          ? sendEmail({ to: target, subject: "Your BookMeStays code", html: `<p>${message}</p>`, text: message })
          : sendSms(target, message, code),
      );
      return { sent: true, target, ...(env.isProd ? {} : { devCode: code }) };
    },
    { body: t.Object({ target: t.String({ minLength: 5 }) }) },
  )

  .post(
    "/otp/verify",
    async ({ body, cookie, headers, startSession }) => {
      const target = isEmail(body.target) ? body.target.trim().toLowerCase() : normalizePhone(body.target);
      const otp = await db.query.otpCodes.findFirst({
        where: and(
          eq(otpCodes.target, target),
          eq(otpCodes.purpose, "LOGIN"),
          isNull(otpCodes.consumedAt),
          gt(otpCodes.expiresAt, new Date()),
        ),
        orderBy: desc(otpCodes.createdAt),
      });
      if (!otp || otp.attempts >= 5) throw unauthorized("Code expired. Please request a new one");
      if (otp.codeHash !== sha256(body.code)) {
        await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
        throw unauthorized("Incorrect code");
      }
      await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));

      const byEmail = isEmail(target);
      let user = await db.query.users.findFirst({
        where: byEmail ? sql`lower(${users.email}) = ${target}` : eq(users.phone, target),
      });
      if (!user) {
        [user] = await db
          .insert(users)
          .values({
            name: body.name?.trim() || null,
            email: byEmail ? target : null,
            phone: byEmail ? null : target,
            emailVerified: byEmail,
            phoneVerified: !byEmail,
            role: "CUSTOMER",
          })
          .returning();
      } else {
        await db
          .update(users)
          .set(byEmail ? { emailVerified: true } : { phoneVerified: true })
          .where(eq(users.id, user.id));
      }
      return startSession(user.id, cookie, { userAgent: headers["user-agent"] });
    },
    {
      body: t.Object({
        target: t.String({ minLength: 5 }),
        code: t.String({ minLength: 6, maxLength: 6 }),
        name: t.Optional(t.String({ maxLength: 160 })),
      }),
    },
  )

  .post("/refresh", async ({ cookie, body }) => {
    const token = (cookie[REFRESH_COOKIE]?.value as string | undefined) ?? body?.refreshToken;
    if (!token) throw unauthorized();
    const userId = await rotateRefreshToken(token);
    if (!userId) {
      cookie[ACCESS_COOKIE].remove();
      cookie[REFRESH_COOKIE].remove();
      throw unauthorized("Session expired. Please sign in again");
    }
    const authUser = await buildAuthUser(userId);
    const tokens = await issueTokens(authUser, {});
    cookie[ACCESS_COOKIE].set({ value: tokens.accessToken, ...cookieOptions(ACCESS_MAX_AGE) });
    cookie[REFRESH_COOKIE].set({ value: tokens.refreshToken, ...cookieOptions(REFRESH_MAX_AGE) });
    return { accessToken: tokens.accessToken };
  }, { body: t.Optional(t.Object({ refreshToken: t.Optional(t.String()) })) })

  .post("/logout", async ({ cookie }) => {
    const token = cookie[REFRESH_COOKIE]?.value as string | undefined;
    if (token) await revokeRefreshToken(token);
    cookie[ACCESS_COOKIE].remove();
    cookie[REFRESH_COOKIE].remove();
    return { ok: true };
  })

  .get(
    "/me",
    async ({ authUser }) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
      if (!user) throw unauthorized();
      return { user: publicUser(user), partnerId: authUser.partnerId, permissions: authUser.permissions };
    },
    { auth: true },
  )

  .patch(
    "/me",
    async ({ authUser, body }) => {
      const [user] = await db
        .update(users)
        .set({ name: body.name, avatarUrl: body.avatarUrl })
        .where(eq(users.id, authUser.id))
        .returning();
      return { user: publicUser(user) };
    },
    {
      auth: true,
      body: t.Object({ name: t.Optional(t.String({ maxLength: 160 })), avatarUrl: t.Optional(t.String()) }),
    },
  )

  .post(
    "/change-password",
    async ({ authUser, body, cookie }) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
      if (user?.passwordHash && !(await Bun.password.verify(body.currentPassword ?? "", user.passwordHash)))
        throw unauthorized("Current password is incorrect");
      await db
        .update(users)
        .set({ passwordHash: await Bun.password.hash(body.newPassword), mustChangePassword: false })
        .where(eq(users.id, authUser.id));
      cookie[ACCESS_COOKIE].set({ value: await signAccessToken(authUser), ...cookieOptions(ACCESS_MAX_AGE) });
      return { ok: true };
    },
    {
      auth: true,
      body: t.Object({ currentPassword: t.Optional(t.String()), newPassword: t.String({ minLength: 8 }) }),
    },
  );
