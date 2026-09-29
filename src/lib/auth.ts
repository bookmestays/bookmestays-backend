import { and, eq, gt, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env";
import { db } from "../db";
import { partnerUsers, sessions, users } from "../db/schema";
import { forbidden, unauthorized } from "./errors";
import { randomCode, sha256 } from "./utils";

export type Role = (typeof users.$inferSelect)["role"];

export type AuthUser = {
  id: string;
  role: Role;
  partnerId: string | null; // set for PARTNER_OWNER / PARTNER_STAFF
  permissions: string[]; // partner staff permissions
};

export const ADMIN_ROLES: Role[] = ["SUPER_ADMIN", "ADMIN_STAFF"];
export const PARTNER_ROLES: Role[] = ["PARTNER_OWNER", "PARTNER_STAFF"];

export const ACCESS_COOKIE = "bms_at";
export const REFRESH_COOKIE = "bms_rt";

const accessKey = new TextEncoder().encode(env.jwtAccessSecret);

export async function signAccessToken(u: AuthUser) {
  return new SignJWT({ role: u.role, pid: u.partnerId, perms: u.permissions })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.id)
    .setIssuedAt()
    .setExpirationTime(env.accessTokenTtl)
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey);
    return {
      id: payload.sub!,
      role: payload.role as Role,
      partnerId: (payload.pid as string | null) ?? null,
      permissions: (payload.perms as string[]) ?? [],
    };
  } catch {
    return null;
  }
}

/** Load the claims we put in the token (partner membership etc.) */
export async function buildAuthUser(userId: string): Promise<AuthUser> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.isActive) throw unauthorized("Account is disabled");
  let partnerId: string | null = null;
  let permissions: string[] = [];
  if (PARTNER_ROLES.includes(user.role)) {
    const link = await db.query.partnerUsers.findFirst({ where: eq(partnerUsers.userId, user.id) });
    partnerId = link?.partnerId ?? null;
    permissions = link?.permissions ?? [];
  }
  return { id: user.id, role: user.role, partnerId, permissions };
}

/** Creates a session and returns [accessToken, refreshToken]. Refresh token = `${sessionId}.${secret}` */
export async function issueTokens(u: AuthUser, meta: { userAgent?: string; ip?: string }) {
  const secret = randomCode(48);
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000);
  const [session] = await db
    .insert(sessions)
    .values({
      userId: u.id,
      refreshTokenHash: sha256(secret),
      userAgent: meta.userAgent?.slice(0, 500),
      ip: meta.ip,
      expiresAt,
    })
    .returning({ id: sessions.id });
  return { accessToken: await signAccessToken(u), refreshToken: `${session.id}.${secret}`, expiresAt };
}

/** Validates + rotates a refresh token. Returns the user id or null. */
export async function rotateRefreshToken(token: string) {
  const [sessionId, secret] = token.split(".");
  if (!sessionId || !secret) return null;
  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())),
  });
  if (!session || session.refreshTokenHash !== sha256(secret)) return null;
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  return session.userId;
}

export async function revokeRefreshToken(token: string) {
  const [sessionId] = token.split(".");
  if (sessionId) await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId)).catch(() => {});
}

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeSeconds,
});

/**
 * Auth plugin. Adds `user` (AuthUser | null) to every request, plus route macros:
 *   { auth: true }                       → any signed-in user
 *   { auth: ["SUPER_ADMIN", ...] }       → only these roles
 * Partner routes additionally get a guaranteed `partnerId` via `{ partner: true }`
 * (optionally a permission string: `{ partner: "inventory" }`).
 */
export const authPlugin = new Elysia({ name: "auth" })
  .derive({ as: "global" }, async ({ headers, cookie }) => {
    const bearer = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : undefined;
    const token = bearer ?? (cookie[ACCESS_COOKIE]?.value as string | undefined);
    return { user: token ? await verifyAccessToken(token) : null };
  })
  .macro({
    auth: (roles: true | Role[]) => ({
      resolve({ user }: { user: AuthUser | null }) {
        if (!user) throw unauthorized();
        if (roles !== true && !roles.includes(user.role)) throw forbidden();
        return { authUser: user };
      },
    }),
    partner: (permission: true | string) => ({
      resolve({ user }: { user: AuthUser | null }) {
        if (!user) throw unauthorized();
        if (!PARTNER_ROLES.includes(user.role) || !user.partnerId) throw forbidden("Partner account required");
        if (
          permission !== true &&
          user.role === "PARTNER_STAFF" &&
          !user.permissions.includes(permission)
        )
          throw forbidden(`Missing permission: ${permission}`);
        return { authUser: user, partnerId: user.partnerId };
      },
    }),
  });
