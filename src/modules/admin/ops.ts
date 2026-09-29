// Admin: review moderation, coupons, users, site settings, audit logs.
import { and, count, desc, eq, ilike, inArray, isNull, ne, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { auditLogs, coupons, properties, reviews, sessions, siteSettings, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { pageParams, paginated } from "../../lib/utils";
import { publicUser } from "../auth";
import { createUserWithTempPassword, normalizePhone } from "../../services/catalog/accounts";
import { iso } from "../../services/catalog/dto";
import { recomputeRating } from "../../services/catalog/maintenance";
import { buildReviews } from "../../services/catalog/property-detail";
import { invalidateMetaCache } from "../public";
import { defined, lit, money, nstr, pageQuery } from "./schemas";

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const likeOf = (q: string) => `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

// ─── Reviews ──────────────────────────────────────────────────────────────────

async function adminReviews(rows: (typeof reviews.$inferSelect)[]) {
  if (!rows.length) return [];
  const [dtos, props, authors] = await Promise.all([
    buildReviews(rows),
    db
      .select({ id: properties.id, name: properties.name, slug: properties.slug })
      .from(properties)
      .where(inArray(properties.id, [...new Set(rows.map((r) => r.propertyId))])),
    db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.userId))])),
  ]);
  const propMap = new Map(props.map((p) => [p.id, p]));
  const authorMap = new Map(authors.map((a) => [a.id, a]));
  return rows.map((r, i) => ({
    ...dtos[i],
    status: r.status,
    propertyId: r.propertyId,
    propertyName: propMap.get(r.propertyId)?.name ?? null,
    propertySlug: propMap.get(r.propertyId)?.slug ?? null,
    bookingId: r.bookingId,
    userId: r.userId,
    authorFullName: authorMap.get(r.userId)?.name ?? null,
    authorEmail: authorMap.get(r.userId)?.email ?? null,
    partnerRepliedAt: iso(r.partnerRepliedAt),
    updatedAt: iso(r.updatedAt)!,
  }));
}

// ─── Coupons ──────────────────────────────────────────────────────────────────

const toCoupon = (c: typeof coupons.$inferSelect) => ({
  id: c.id,
  code: c.code,
  description: c.description,
  type: c.type,
  value: c.value,
  maxDiscount: c.maxDiscount,
  minBookingAmount: c.minBookingAmount,
  validFrom: iso(c.validFrom),
  validTo: iso(c.validTo),
  usageLimit: c.usageLimit,
  perUserLimit: c.perUserLimit,
  usedCount: c.usedCount,
  propertyId: c.propertyId,
  fundedBy: c.fundedBy,
  isActive: c.isActive,
  createdAt: iso(c.createdAt)!,
  updatedAt: iso(c.updatedAt)!,
});

const couponFields = {
  code: t.String({ minLength: 3, maxLength: 40, pattern: "^[A-Za-z0-9_-]+$" }),
  description: t.Optional(nstr(1000)),
  type: lit(["PERCENT", "FLAT"] as const),
  value: t.Integer({ minimum: 1 }),
  maxDiscount: t.Optional(t.Nullable(money)),
  minBookingAmount: t.Optional(money),
  validFrom: t.Optional(t.Nullable(t.String({ format: "date-time" }))),
  validTo: t.Optional(t.Nullable(t.String({ format: "date-time" }))),
  usageLimit: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
  perUserLimit: t.Optional(t.Integer({ minimum: 1 })),
  propertyId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  fundedBy: t.Optional(lit(["PLATFORM", "PARTNER"] as const)),
  isActive: t.Optional(t.Boolean()),
};

function couponCols(body: Record<string, unknown>) {
  const cols: Record<string, unknown> = defined(body);
  if (typeof cols.code === "string") cols.code = cols.code.toUpperCase();
  for (const k of ["validFrom", "validTo"]) if (typeof cols[k] === "string") cols[k] = new Date(cols[k] as string);
  return cols;
}

// ─── Users ────────────────────────────────────────────────────────────────────

const adminUser = (u: typeof users.$inferSelect) => ({
  ...publicUser(u),
  isActive: u.isActive,
  emailVerified: u.emailVerified,
  phoneVerified: u.phoneVerified,
  lastLoginAt: iso(u.lastLoginAt),
  createdAt: iso(u.createdAt)!,
});
const ROLE_VALUES = ["SUPER_ADMIN", "ADMIN_STAFF", "PARTNER_OWNER", "PARTNER_STAFF", "CUSTOMER"] as const;

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_SCHEMAS = {
  tax: t.Object({
    roomGstSlabs: t.Optional(
      t.Array(t.Object({ upToPerNight: t.Nullable(t.Integer({ minimum: 0 })), rateBps: t.Integer({ minimum: 0, maximum: 10000 }) }), {
        minItems: 1,
        maxItems: 10,
      }),
    ),
    commissionGstBps: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
    tcsBps: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
    tdsBps: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
  }),
  booking: t.Object({
    holdMinutes: t.Optional(t.Integer({ minimum: 5, maximum: 120 })),
    maxRoomsPerBooking: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    maxNights: t.Optional(t.Integer({ minimum: 1, maximum: 365 })),
  }),
  ranking: t.Object({
    // MOST_BOOKED_FIRST: stays guests book most come first; PINS_FIRST: the admin's manual order wins
    mode: t.Optional(t.Union([t.Literal("MOST_BOOKED_FIRST"), t.Literal("PINS_FIRST")])),
  }),
  support: t.Object({
    phone: t.Optional(t.String({ maxLength: 40 })),
    email: t.Optional(t.String({ maxLength: 255 })),
    whatsapp: t.Optional(t.String({ maxLength: 40 })),
    social: t.Optional(t.Record(t.String(), t.String())),
  }),
};
type SettingKey = keyof typeof SETTINGS_SCHEMAS;
const SETTING_KEYS = Object.keys(SETTINGS_SCHEMAS) as SettingKey[];

async function saveSetting(actor: Parameters<typeof audit>[0], key: SettingKey, value: Record<string, unknown>) {
  const existing = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, key) });
  const merged = { ...((existing?.value as object) ?? {}), ...defined(value) };
  const [row] = await db
    .insert(siteSettings)
    .values({ key, value: merged })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: merged, updatedAt: new Date() } })
    .returning();
  if (key === "support") invalidateMetaCache();
  await audit(actor, "settings.update", "setting", key, value);
  return { key, value: row.value, updatedAt: iso(row.updatedAt) };
}

export const adminOps = new Elysia({ name: "admin-ops" })
  .use(authPlugin)
  .guard({ auth: ADMIN_ROLES }, (app) =>
    app
      // ─── Reviews moderation ───────────────────────────────────────────────
      .get(
        "/reviews",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const where = and(
            query.status ? eq(reviews.status, query.status) : undefined,
            query.propertyId ? eq(reviews.propertyId, query.propertyId) : undefined,
            query.rating ? eq(reviews.rating, Number(query.rating)) : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(reviews).where(where).orderBy(desc(reviews.createdAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(reviews).where(where),
          ]);
          return paginated(await adminReviews(rows), n, page, limit);
        },
        {
          query: t.Object({
            status: t.Optional(lit(["PENDING", "PUBLISHED", "HIDDEN"] as const)),
            propertyId: t.Optional(t.String({ format: "uuid" })),
            rating: t.Optional(t.String()),
            ...pageQuery,
          }),
        },
      )
      .patch(
        "/reviews/:id",
        async ({ authUser, params, body }) => {
          const r = await db.query.reviews.findFirst({ where: eq(reviews.id, params.id) });
          if (!r) throw notFound("Review");
          const [row] = await db.transaction(async (tx) => {
            const updated = await tx
              .update(reviews)
              .set(defined({ status: body.status, partnerReply: body.partnerReply }))
              .where(eq(reviews.id, r.id))
              .returning();
            await recomputeRating(r.propertyId, tx);
            return updated;
          });
          await audit(authUser, "review.moderate", "review", r.id, { from: r.status, ...body });
          return (await adminReviews([row]))[0];
        },
        {
          params: idParams,
          body: t.Object({
            status: lit(["PENDING", "PUBLISHED", "HIDDEN"] as const),
            partnerReply: t.Optional(nstr(5000)),
          }),
        },
      )

      // ─── Coupons ──────────────────────────────────────────────────────────
      .get(
        "/coupons",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const where = and(
            query.q ? or(ilike(coupons.code, likeOf(query.q)), ilike(coupons.description, likeOf(query.q))) : undefined,
            query.isActive ? eq(coupons.isActive, query.isActive === "true") : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(coupons).where(where).orderBy(desc(coupons.createdAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(coupons).where(where),
          ]);
          return paginated(rows.map(toCoupon), n, page, limit);
        },
        { query: t.Object({ q: t.Optional(t.String()), isActive: t.Optional(t.String()), ...pageQuery }) },
      )
      .get(
        "/coupons/:id",
        async ({ params }) => {
          const c = await db.query.coupons.findFirst({ where: eq(coupons.id, params.id) });
          if (!c) throw notFound("Coupon");
          return toCoupon(c);
        },
        { params: idParams },
      )
      .post(
        "/coupons",
        async ({ authUser, body }) => {
          if (body.type === "PERCENT" && body.value > 10_000) throw badRequest("Percentage cannot exceed 100% (10000 bps)");
          const code = body.code.toUpperCase();
          if (await db.query.coupons.findFirst({ where: eq(coupons.code, code) }))
            throw conflict("A coupon with this code already exists");
          if (body.propertyId && !(await db.query.properties.findFirst({ where: eq(properties.id, body.propertyId) })))
            throw badRequest("Selected property does not exist");
          const [row] = await db.insert(coupons).values(couponCols(body) as typeof coupons.$inferInsert).returning();
          await audit(authUser, "coupon.create", "coupon", row.id, body);
          return toCoupon(row);
        },
        { body: t.Object(couponFields) },
      )
      .patch(
        "/coupons/:id",
        async ({ authUser, params, body }) => {
          const c = await db.query.coupons.findFirst({ where: eq(coupons.id, params.id) });
          if (!c) throw notFound("Coupon");
          if ((body.type ?? c.type) === "PERCENT" && (body.value ?? c.value) > 10_000)
            throw badRequest("Percentage cannot exceed 100% (10000 bps)");
          if (body.code) {
            const clash = await db.query.coupons.findFirst({
              where: and(eq(coupons.code, body.code.toUpperCase()), ne(coupons.id, c.id)),
            });
            if (clash) throw conflict("A coupon with this code already exists");
          }
          const [row] = await db.update(coupons).set(couponCols(body)).where(eq(coupons.id, c.id)).returning();
          await audit(authUser, "coupon.update", "coupon", c.id, body);
          return toCoupon(row);
        },
        { params: idParams, body: t.Partial(t.Object(couponFields)) },
      )
      .delete(
        "/coupons/:id",
        async ({ authUser, params }) => {
          const c = await db.query.coupons.findFirst({ where: eq(coupons.id, params.id) });
          if (!c) throw notFound("Coupon");
          // Used coupons are referenced by bookings → deactivate instead of deleting.
          const deleted = await db
            .delete(coupons)
            .where(eq(coupons.id, c.id))
            .returning()
            .catch(() => null);
          if (!deleted) await db.update(coupons).set({ isActive: false }).where(eq(coupons.id, c.id));
          await audit(authUser, deleted ? "coupon.delete" : "coupon.deactivate", "coupon", c.id, { code: c.code });
          return { ok: true };
        },
        { params: idParams },
      )

      // ─── Users ────────────────────────────────────────────────────────────
      .get(
        "/users",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const roles = query.role ? query.role.split(",").filter((r) => (ROLE_VALUES as readonly string[]).includes(r)) : [];
          const where = and(
            roles.length ? inArray(users.role, roles as (typeof ROLE_VALUES)[number][]) : undefined,
            query.isActive ? eq(users.isActive, query.isActive === "true") : undefined,
            query.q
              ? or(ilike(users.name, likeOf(query.q)), ilike(users.email, likeOf(query.q)), ilike(users.phone, likeOf(query.q)))
              : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(users).where(where),
          ]);
          return paginated(rows.map(adminUser), n, page, limit);
        },
        { query: t.Object({ role: t.Optional(t.String()), q: t.Optional(t.String()), isActive: t.Optional(t.String()), ...pageQuery }) },
      )
      .post(
        "/users",
        async ({ authUser, body }) => {
          if (authUser.role !== "SUPER_ADMIN") throw forbidden("Only a super admin can create admin users");
          const { user, tempPassword } = await createUserWithTempPassword(db, {
            name: body.name,
            email: body.email,
            phone: body.phone,
            role: "ADMIN_STAFF",
            password: body.password,
          });
          await audit(authUser, "user.create", "user", user.id, { email: user.email, role: user.role });
          return { user: adminUser(user), tempPassword };
        },
        {
          body: t.Object({
            name: t.String({ minLength: 2, maxLength: 160 }),
            email: t.String({ format: "email" }),
            phone: t.Optional(t.String({ minLength: 10, maxLength: 20 })),
            password: t.Optional(t.String({ minLength: 8 })),
          }),
        },
      )
      .patch(
        "/users/:id",
        async ({ authUser, params, body }) => {
          const u = await db.query.users.findFirst({ where: eq(users.id, params.id) });
          if (!u) throw notFound("User");
          const targetIsAdmin = ADMIN_ROLES.includes(u.role);
          if ((targetIsAdmin || body.role) && authUser.role !== "SUPER_ADMIN")
            throw forbidden("Only a super admin can change admin accounts");
          if (u.id === authUser.id && (body.isActive === false || body.role))
            throw badRequest("You cannot deactivate or change the role of your own account");
          if (body.role && !targetIsAdmin) throw badRequest("Only admin roles can be changed here");
          const cols: Record<string, unknown> = defined({ isActive: body.isActive, name: body.name, role: body.role });
          if (body.phone !== undefined) cols.phone = body.phone ? normalizePhone(body.phone) : null;
          const [row] = await db.update(users).set(cols).where(eq(users.id, u.id)).returning();
          if (body.isActive === false)
            await db
              .update(sessions)
              .set({ revokedAt: new Date() })
              .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
          await audit(authUser, body.isActive === false ? "user.deactivate" : body.isActive ? "user.activate" : "user.update", "user", u.id, body);
          return adminUser(row);
        },
        {
          params: idParams,
          body: t.Object({
            isActive: t.Optional(t.Boolean()),
            name: t.Optional(t.String({ minLength: 2, maxLength: 160 })),
            phone: t.Optional(t.Nullable(t.String({ minLength: 10, maxLength: 20 }))),
            role: t.Optional(lit(["SUPER_ADMIN", "ADMIN_STAFF"] as const)),
          }),
        },
      )

      // ─── Settings ─────────────────────────────────────────────────────────
      .get(
        "/settings/:key",
        async ({ params }) => {
          if (!SETTING_KEYS.includes(params.key as SettingKey)) throw notFound("Setting");
          const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, params.key) });
          return { key: params.key, value: row?.value ?? {}, updatedAt: iso(row?.updatedAt) };
        },
      )
      // Body = the (partial) setting object; it is merged into the stored value.
      .put("/settings/tax", ({ authUser, body }) => saveSetting(authUser, "tax", body), { body: SETTINGS_SCHEMAS.tax })
      .put("/settings/ranking", ({ authUser, body }) => saveSetting(authUser, "ranking", body), {
        body: SETTINGS_SCHEMAS.ranking,
      })
      .put("/settings/booking", ({ authUser, body }) => saveSetting(authUser, "booking", body), {
        body: SETTINGS_SCHEMAS.booking,
      })
      .put("/settings/support", ({ authUser, body }) => saveSetting(authUser, "support", body), {
        body: SETTINGS_SCHEMAS.support,
      })

      // ─── Audit logs ───────────────────────────────────────────────────────
      .get(
        "/audit-logs",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const where = and(
            query.entity ? eq(auditLogs.entity, query.entity) : undefined,
            query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
            query.actorUserId ? eq(auditLogs.actorUserId, query.actorUserId) : undefined,
            query.action ? ilike(auditLogs.action, `${query.action.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db
              .select({ log: auditLogs, actorName: users.name, actorEmail: users.email })
              .from(auditLogs)
              .leftJoin(users, eq(users.id, auditLogs.actorUserId))
              .where(where)
              .orderBy(desc(auditLogs.createdAt))
              .limit(limit)
              .offset(offset),
            db.select({ n: count() }).from(auditLogs).where(where),
          ]);
          return paginated(
            rows.map(({ log, actorName, actorEmail }) => ({
              id: log.id,
              actorUserId: log.actorUserId,
              actorName,
              actorEmail,
              actorRole: log.actorRole,
              action: log.action,
              entity: log.entity,
              entityId: log.entityId,
              data: log.data,
              ip: log.ip,
              createdAt: iso(log.createdAt)!,
            })),
            n,
            page,
            limit,
          );
        },
        {
          query: t.Object({
            entity: t.Optional(t.String()),
            entityId: t.Optional(t.String()),
            actorUserId: t.Optional(t.String({ format: "uuid" })),
            action: t.Optional(t.String()),
            ...pageQuery,
          }),
        },
      ),
  );

