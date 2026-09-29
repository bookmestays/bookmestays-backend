// Partner: staff management (owner only) and guest reviews + replies.
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { db } from "../../db";
import { partners, partnerUsers, properties, reviews, sessions, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { authPlugin } from "../../lib/auth";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { notifyLater, sendEmail } from "../../lib/notify";
import { pageParams, paginated } from "../../lib/utils";
import { publicUser } from "../auth";
import {
  assertUserUnique,
  createUserWithTempPassword,
  linkPartnerUser,
  normalizePhone,
  STAFF_PERMISSIONS,
} from "../../services/catalog/accounts";
import { iso } from "../../services/catalog/dto";
import { partnerUsersList } from "../../services/catalog/partners";
import { buildReviews } from "../../services/catalog/property-detail";
import { lit, pageQuery } from "../admin/schemas";

const permissionsSchema = t.Array(lit(STAFF_PERMISSIONS), { maxItems: STAFF_PERMISSIONS.length });
const ownerOnly = (role: string) => {
  if (role !== "PARTNER_OWNER") throw forbidden("Only the account owner can manage staff");
};

async function staffMember(partnerId: string, userId: string) {
  const [row] = await db
    .select({ user: users, permissions: partnerUsers.permissions })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(and(eq(partnerUsers.partnerId, partnerId), eq(partnerUsers.userId, userId)));
  if (!row) throw notFound("Staff member");
  if (row.user.role !== "PARTNER_STAFF") throw badRequest("The account owner cannot be changed here");
  return row;
}
const staffDto = (u: typeof users.$inferSelect, permissions: string[]) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  isActive: u.isActive,
  permissions,
});

export const partnerTeam = new Elysia({ name: "partner-team" })
  .use(authPlugin)

  // ─── Staff ──────────────────────────────────────────────────────────────────
  .get(
    "/staff",
    ({ authUser, partnerId }) => {
      ownerOnly(authUser.role);
      return partnerUsersList(partnerId);
    },
    { partner: true },
  )
  .post(
    "/staff",
    async ({ authUser, partnerId, body }) => {
      ownerOnly(authUser.role);
      const partner = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
      const { user, tempPassword } = await db.transaction(async (tx) => {
        const created = await createUserWithTempPassword(tx, {
          name: body.name,
          email: body.email,
          phone: body.phone,
          role: "PARTNER_STAFF",
        });
        await linkPartnerUser(tx, partnerId, created.user.id, [...new Set(body.permissions)]);
        return created;
      });
      notifyLater(
        sendEmail({
          to: user.email!,
          subject: `You've been added to ${partner?.displayName ?? "a partner"} on BookMeStays`,
          text: `Hi ${body.name},\n\nYou now have access to the ${partner?.displayName ?? ""} partner panel: ${env.webUrl.replace("://", "://partner.")}\nEmail: ${user.email}\nTemporary password: ${tempPassword}\n\nYou will be asked to choose a new password when you first sign in.`,
          html: `<p>Hi ${body.name},</p><p>You now have access to the <b>${partner?.displayName ?? ""}</b> partner panel.</p><p>Email: ${user.email}<br/>Temporary password: <b>${tempPassword}</b></p>`,
        }),
      );
      await audit(authUser, "partner_staff.create", "user", user.id, { partnerId, permissions: body.permissions });
      return { user: publicUser(user), tempPassword };
    },
    {
      partner: true,
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 160 }),
        email: t.String({ format: "email" }),
        phone: t.Optional(t.String({ minLength: 10, maxLength: 20 })),
        permissions: permissionsSchema,
      }),
    },
  )
  .patch(
    "/staff/:userId",
    async ({ authUser, partnerId, params, body }) => {
      ownerOnly(authUser.role);
      const { user } = await staffMember(partnerId, params.userId);
      const phone = body.phone === undefined ? undefined : body.phone ? normalizePhone(body.phone) : null;
      if (phone) await assertUserUnique(db, user.email ?? "", phone, user.id);
      await db.transaction(async (tx) => {
        const cols: Record<string, unknown> = {};
        if (body.name !== undefined) cols.name = body.name;
        if (phone !== undefined) cols.phone = phone;
        if (body.isActive !== undefined) cols.isActive = body.isActive;
        if (Object.keys(cols).length) await tx.update(users).set(cols).where(eq(users.id, user.id));
        if (body.permissions)
          await tx
            .update(partnerUsers)
            .set({ permissions: [...new Set(body.permissions)] })
            .where(and(eq(partnerUsers.partnerId, partnerId), eq(partnerUsers.userId, user.id)));
        // Permission / status changes take effect on next sign-in: revoke sessions.
        if (body.permissions || body.isActive === false)
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      });
      await audit(authUser, "partner_staff.update", "user", user.id, body);
      const updated = await staffMember(partnerId, user.id);
      return staffDto(updated.user, updated.permissions);
    },
    {
      partner: true,
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 2, maxLength: 160 })),
        phone: t.Optional(t.Nullable(t.String({ minLength: 10, maxLength: 20 }))),
        permissions: t.Optional(permissionsSchema),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete(
    "/staff/:userId",
    async ({ authUser, partnerId, params }) => {
      ownerOnly(authUser.role);
      const { user } = await staffMember(partnerId, params.userId);
      await db.transaction(async (tx) => {
        await tx.delete(partnerUsers).where(and(eq(partnerUsers.partnerId, partnerId), eq(partnerUsers.userId, user.id)));
        await tx.update(users).set({ isActive: false }).where(eq(users.id, user.id));
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      });
      await audit(authUser, "partner_staff.remove", "user", user.id, { partnerId });
      return { ok: true };
    },
    { partner: true, params: t.Object({ userId: t.String({ format: "uuid" }) }) },
  )

  // ─── Reviews ────────────────────────────────────────────────────────────────
  .get(
    "/reviews",
    async ({ partnerId, query }) => {
      const { page, limit, offset } = pageParams(query);
      const own = await db
        .select({ id: properties.id, name: properties.name })
        .from(properties)
        .where(eq(properties.partnerId, partnerId));
      const ids = query.propertyId ? own.filter((p) => p.id === query.propertyId).map((p) => p.id) : own.map((p) => p.id);
      if (query.propertyId && !ids.length) throw notFound("Property");
      if (!ids.length) return paginated([], 0, page, limit);
      const where = and(
        inArray(reviews.propertyId, ids),
        query.status ? eq(reviews.status, query.status) : undefined,
      );
      const [rows, [{ n }]] = await Promise.all([
        db.select().from(reviews).where(where).orderBy(desc(reviews.createdAt)).limit(limit).offset(offset),
        db.select({ n: count() }).from(reviews).where(where),
      ]);
      const names = new Map(own.map((p) => [p.id, p.name]));
      const dtos = await buildReviews(rows);
      return paginated(
        rows.map((r, i) => ({
          ...dtos[i],
          status: r.status,
          propertyId: r.propertyId,
          propertyName: names.get(r.propertyId) ?? null,
          partnerRepliedAt: iso(r.partnerRepliedAt),
        })),
        n,
        page,
        limit,
      );
    },
    {
      partner: "reviews",
      query: t.Object({
        propertyId: t.Optional(t.String({ format: "uuid" })),
        status: t.Optional(lit(["PENDING", "PUBLISHED", "HIDDEN"] as const)),
        ...pageQuery,
      }),
    },
  )
  .post(
    "/reviews/:id/reply",
    async ({ authUser, partnerId, params, body }) => {
      const [row] = await db
        .select({ review: reviews, propertyName: properties.name })
        .from(reviews)
        .innerJoin(properties, eq(properties.id, reviews.propertyId))
        .where(and(eq(reviews.id, params.id), eq(properties.partnerId, partnerId)));
      if (!row) throw notFound("Review");
      if (row.review.status === "HIDDEN") throw conflict("This review has been hidden by moderation");
      const [updated] = await db
        .update(reviews)
        .set({ partnerReply: body.reply.trim() || null, partnerRepliedAt: body.reply.trim() ? new Date() : null })
        .where(eq(reviews.id, row.review.id))
        .returning();
      await audit(authUser, "review.reply", "review", updated.id, body);
      const [dto] = await buildReviews([updated]);
      return {
        ...dto,
        status: updated.status,
        propertyId: updated.propertyId,
        propertyName: row.propertyName,
        partnerRepliedAt: iso(updated.partnerRepliedAt),
      };
    },
    { partner: "reviews", params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ reply: t.String({ maxLength: 5000 }) }) },
  );
