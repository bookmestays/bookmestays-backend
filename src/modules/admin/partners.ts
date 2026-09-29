// Admin: partners, KYC, Razorpay Route linked accounts, commission rules.
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { db } from "../../db";
import { cities, commissionRules, partners, properties, roomTypes, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { badRequest, notFound } from "../../lib/errors";
import { notifyLater, sendEmail } from "../../lib/notify";
import { encrypt, pageParams, paginated, randomPassword } from "../../lib/utils";
import { publicUser } from "../auth";
import { createPropertyShell, createUserWithTempPassword, linkPartnerUser } from "../../services/catalog/accounts";
import {
  buildCommissionRules,
  buildPartnerSummaries,
  listCommissionRules,
  partnerDetail,
  partnerOwner,
} from "../../services/catalog/partners";
import { partnerPropertyDetail } from "../../services/catalog/property-detail";
import { createLinkedAccount } from "../../services/catalog/razorpay-route";
import {
  cancellationPolicySchema,
  commissionTypeSchema,
  dateStr,
  defined,
  kycStatusSchema,
  nstr,
  pageQuery,
  propertyTypeSchema,
  settlementCycleSchema,
} from "./schemas";

const partnerFields = {
  legalName: t.String({ minLength: 2, maxLength: 200 }),
  displayName: t.String({ minLength: 2, maxLength: 200 }),
  contactName: t.String({ minLength: 2, maxLength: 160 }),
  email: t.String({ format: "email", maxLength: 255 }),
  phone: t.String({ minLength: 10, maxLength: 20 }),
  address: t.Optional(nstr(1000)),
  gstin: t.Optional(t.Nullable(t.String({ pattern: "^[0-9A-Za-z]{15}$" }))),
  pan: t.Optional(t.Nullable(t.String({ pattern: "^[A-Za-z]{5}[0-9]{4}[A-Za-z]$" }))),
  bankAccountName: t.Optional(nstr(200)),
  bankAccountNumber: t.Optional(t.Nullable(t.String({ pattern: "^[0-9]{6,20}$" }))),
  bankIfsc: t.Optional(t.Nullable(t.String({ pattern: "^[A-Za-z]{4}0[A-Za-z0-9]{6}$" }))),
  settlementCycle: settlementCycleSchema,
  settlementDayOfWeek: t.Optional(t.Nullable(t.Integer({ minimum: 0, maximum: 6 }))),
  settlementDayOfMonth: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 28 }))),
  settlementDelayDays: t.Integer({ minimum: 0, maximum: 90 }),
  defaultCommissionType: commissionTypeSchema,
  defaultCommissionValue: t.Integer({ minimum: 0 }),
  defaultCancellationPolicy: t.Optional(t.Nullable(cancellationPolicySchema)),
  defaultTerms: t.Optional(nstr(20000)),
};

const upper = (s: string | null | undefined) => (s == null ? s : s.trim().toUpperCase());

/** Maps API fields to columns (bank number encrypted, last4 kept). */
function partnerColumns(body: Partial<Record<keyof typeof partnerFields, unknown>> & Record<string, unknown>) {
  const { bankAccountNumber, gstin, pan, bankIfsc, email, ...rest } = body as Record<string, any>;
  const cols: Record<string, unknown> = { ...rest };
  if (email !== undefined) cols.email = String(email).trim().toLowerCase();
  if (gstin !== undefined) cols.gstin = upper(gstin) || null;
  if (pan !== undefined) cols.pan = upper(pan) || null;
  if (bankIfsc !== undefined) cols.bankIfsc = upper(bankIfsc) || null;
  if (bankAccountNumber !== undefined) {
    cols.bankAccountNumberEnc = bankAccountNumber ? encrypt(bankAccountNumber) : null;
    cols.bankAccountLast4 = bankAccountNumber ? String(bankAccountNumber).slice(-4) : null;
  }
  return defined(cols);
}

const validateCommission = (type: string, value: number) => {
  if (type === "PERCENT" && value > 10_000) throw badRequest("Commission percentage cannot exceed 100% (10000 bps)");
};

async function loadPartner(id: string) {
  const p = await db.query.partners.findFirst({ where: eq(partners.id, id) });
  if (!p) throw notFound("Partner");
  return p;
}

const welcomeEmail = (to: string, name: string, partnerName: string, tempPassword: string) =>
  sendEmail({
    to,
    subject: "Welcome to BookMeStays — your partner account",
    text: `Hi ${name},\n\n${partnerName} is now set up on BookMeStays.\n\nSign in to the partner panel: ${env.webUrl.replace("://", "://partner.")}\nEmail: ${to}\nTemporary password: ${tempPassword}\n\nYou will be asked to choose a new password when you first sign in.\n\n— Team BookMeStays`,
    html: `<p>Hi ${name},</p><p><b>${partnerName}</b> is now set up on BookMeStays.</p><p>Email: ${to}<br/>Temporary password: <b>${tempPassword}</b></p><p>You will be asked to choose a new password when you first sign in.</p><p>— Team BookMeStays</p>`,
  });

export const adminPartners = new Elysia({ name: "admin-partners" })
  .use(authPlugin)
  .guard({ auth: ADMIN_ROLES }, (app) =>
    app
      .get(
        "/partners",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const q = query.q?.trim();
          const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
          const where = and(
            query.status ? eq(partners.status, query.status as never) : undefined,
            query.kycStatus ? eq(partners.kycStatus, query.kycStatus as never) : undefined,
            like
              ? or(
                  ilike(partners.displayName, like),
                  ilike(partners.legalName, like),
                  ilike(partners.email, like),
                  ilike(partners.phone, like),
                  ilike(partners.contactName, like),
                )
              : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(partners).where(where).orderBy(desc(partners.createdAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(partners).where(where),
          ]);
          return paginated(await buildPartnerSummaries(rows), n, page, limit);
        },
        {
          query: t.Object({
            q: t.Optional(t.String()),
            status: t.Optional(t.Union([t.Literal("ACTIVE"), t.Literal("SUSPENDED"), t.Literal("INACTIVE")])),
            kycStatus: t.Optional(kycStatusSchema),
            ...pageQuery,
          }),
        },
      )

      .post(
        "/partners",
        async ({ authUser, body }) => {
          validateCommission(body.defaultCommissionType, body.defaultCommissionValue);
          if (body.property) {
            const city = await db.query.cities.findFirst({ where: eq(cities.id, body.property.cityId) });
            if (!city) throw badRequest("Selected city does not exist");
          }
          const { property: propertyInput, sendWelcomeEmail, ...fields } = body;
          const result = await db.transaction(async (tx) => {
            const [partner] = await tx
              .insert(partners)
              .values({ ...(partnerColumns(fields) as typeof partners.$inferInsert), createdBy: authUser.id })
              .returning();
            const { user, tempPassword } = await createUserWithTempPassword(tx, {
              name: body.contactName,
              email: body.email,
              phone: body.phone,
              role: "PARTNER_OWNER",
            });
            await linkPartnerUser(tx, partner.id, user.id);
            const property = propertyInput
              ? await createPropertyShell(tx, partner, {
                  name: propertyInput.name,
                  type: propertyInput.type,
                  cityId: propertyInput.cityId,
                })
              : null;
            return { partner, user, tempPassword, property };
          });
          if (sendWelcomeEmail !== false)
            notifyLater(welcomeEmail(result.user.email!, body.contactName, body.displayName, result.tempPassword));
          await audit(authUser, "partner.create", "partner", result.partner.id, {
            displayName: body.displayName,
            ownerUserId: result.user.id,
            propertyId: result.property?.id,
          });
          return {
            partner: await partnerDetail(result.partner.id),
            owner: publicUser(result.user),
            tempPassword: result.tempPassword,
            ...(result.property ? { property: await partnerPropertyDetail(result.property) } : {}),
          };
        },
        {
          body: t.Object({
            ...partnerFields,
            property: t.Optional(
              t.Object({ name: t.String({ minLength: 2, maxLength: 200 }), type: propertyTypeSchema, cityId: t.String({ format: "uuid" }) }),
            ),
            sendWelcomeEmail: t.Optional(t.Boolean()),
          }),
        },
      )

      .get("/partners/:id", async ({ params }) => {
        await loadPartner(params.id);
        return partnerDetail(params.id);
      }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })

      .patch(
        "/partners/:id",
        async ({ authUser, params, body }) => {
          const existing = await loadPartner(params.id);
          const type = body.defaultCommissionType ?? existing.defaultCommissionType;
          const value = body.defaultCommissionValue ?? existing.defaultCommissionValue;
          validateCommission(type, value);
          const cols = partnerColumns(body);
          if (Object.keys(cols).length) await db.update(partners).set(cols).where(eq(partners.id, params.id));
          const { bankAccountNumber, ...logged } = body;
          await audit(authUser, "partner.update", "partner", params.id, {
            ...logged,
            ...(bankAccountNumber !== undefined ? { bankAccountNumber: "••••" } : {}),
          });
          return partnerDetail(params.id);
        },
        {
          params: t.Object({ id: t.String({ format: "uuid" }) }),
          body: t.Partial(
            t.Object({
              ...partnerFields,
              status: t.Union([t.Literal("ACTIVE"), t.Literal("SUSPENDED"), t.Literal("INACTIVE")]),
            }),
          ),
        },
      )

      .post(
        "/partners/:id/reset-password",
        async ({ authUser, params }) => {
          const partner = await loadPartner(params.id);
          const owner = await partnerOwner(params.id);
          if (!owner) throw notFound("Partner owner");
          const tempPassword = randomPassword();
          await db
            .update(users)
            .set({ passwordHash: await Bun.password.hash(tempPassword), mustChangePassword: true, isActive: true })
            .where(eq(users.id, owner.id));
          notifyLater(
            sendEmail({
              to: owner.email!,
              subject: "Your BookMeStays partner password was reset",
              text: `Hi ${owner.name ?? ""},\n\nAn administrator reset the password for ${partner.displayName}.\nTemporary password: ${tempPassword}\nYou will be asked to choose a new password when you sign in.\n\n— Team BookMeStays`,
              html: `<p>Hi ${owner.name ?? ""},</p><p>An administrator reset the password for <b>${partner.displayName}</b>.</p><p>Temporary password: <b>${tempPassword}</b></p><p>You will be asked to choose a new password when you sign in.</p>`,
            }),
          );
          await audit(authUser, "partner.reset_password", "partner", params.id, { userId: owner.id });
          return { tempPassword };
        },
        { params: t.Object({ id: t.String({ format: "uuid" }) }) },
      )

      .post(
        "/partners/:id/kyc",
        async ({ authUser, params, body }) => {
          const partner = await loadPartner(params.id);
          await db
            .update(partners)
            .set({ kycStatus: body.status, kycNotes: body.notes ?? null })
            .where(eq(partners.id, params.id));
          if (body.status === "VERIFIED" || body.status === "REJECTED")
            notifyLater(
              sendEmail({
                to: partner.email,
                subject: `KYC ${body.status === "VERIFIED" ? "verified" : "needs attention"} — BookMeStays`,
                text: `Hi ${partner.contactName},\n\nYour KYC status is now ${body.status}.${body.notes ? `\nNotes: ${body.notes}` : ""}\n\n— Team BookMeStays`,
                html: `<p>Hi ${partner.contactName},</p><p>Your KYC status is now <b>${body.status}</b>.</p>${body.notes ? `<p>Notes: ${body.notes}</p>` : ""}`,
              }),
            );
          await audit(authUser, "partner.kyc", "partner", params.id, body);
          return partnerDetail(params.id);
        },
        {
          params: t.Object({ id: t.String({ format: "uuid" }) }),
          body: t.Object({ status: kycStatusSchema, notes: t.Optional(nstr(2000)) }),
        },
      )

      .post(
        "/partners/:id/linked-account",
        async ({ authUser, params, body }) => {
          const partner = await loadPartner(params.id);
          const [firstProperty] = await db
            .select({ city: cities.name, state: cities.state, pincode: properties.pincode })
            .from(properties)
            .leftJoin(cities, eq(cities.id, properties.cityId))
            .where(eq(properties.partnerId, partner.id))
            .orderBy(properties.createdAt)
            .limit(1);
          const accountId = await createLinkedAccount(partner, firstProperty ?? {}, body ?? {});
          await audit(authUser, "partner.linked_account", "partner", params.id, { accountId });
          return partnerDetail(params.id);
        },
        {
          params: t.Object({ id: t.String({ format: "uuid" }) }),
          body: t.Optional(
            t.Object({
              businessType: t.Optional(t.String()),
              category: t.Optional(t.String()),
              subcategory: t.Optional(t.String()),
              street1: t.Optional(t.String({ maxLength: 100 })),
              street2: t.Optional(t.String({ maxLength: 100 })),
              city: t.Optional(t.String()),
              state: t.Optional(t.String()),
              postalCode: t.Optional(t.String({ pattern: "^\\d{6}$" })),
            }),
          ),
        },
      )

      // ─── Commission rules ─────────────────────────────────────────────────
      .get(
        "/partners/:id/commission-rules",
        async ({ params }) => {
          await loadPartner(params.id);
          return listCommissionRules(params.id);
        },
        { params: t.Object({ id: t.String({ format: "uuid" }) }) },
      )

      .post(
        "/partners/:id/commission-rules",
        async ({ authUser, params, body }) => {
          await loadPartner(params.id);
          validateCommission(body.type, body.value);
          let propertyId = body.propertyId ?? null;
          if (body.roomTypeId) {
            const [rt] = await db
              .select({ propertyId: roomTypes.propertyId, partnerId: properties.partnerId })
              .from(roomTypes)
              .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
              .where(eq(roomTypes.id, body.roomTypeId));
            if (!rt || rt.partnerId !== params.id) throw badRequest("Room type does not belong to this partner");
            if (propertyId && propertyId !== rt.propertyId) throw badRequest("Room type does not belong to that property");
            propertyId = rt.propertyId;
          } else if (propertyId) {
            const p = await db.query.properties.findFirst({ where: eq(properties.id, propertyId) });
            if (!p || p.partnerId !== params.id) throw badRequest("Property does not belong to this partner");
          }
          if (body.effectiveTo && body.effectiveFrom && body.effectiveTo < body.effectiveFrom)
            throw badRequest("effectiveTo must be after effectiveFrom");
          const [rule] = await db
            .insert(commissionRules)
            .values({
              partnerId: params.id,
              propertyId,
              roomTypeId: body.roomTypeId ?? null,
              type: body.type,
              value: body.value,
              ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom } : {}),
              effectiveTo: body.effectiveTo ?? null,
              notes: body.notes ?? null,
              createdBy: authUser.id,
            })
            .returning();
          await audit(authUser, "commission_rule.create", "commission_rule", rule.id, body);
          return (await buildCommissionRules([rule]))[0];
        },
        {
          params: t.Object({ id: t.String({ format: "uuid" }) }),
          body: t.Object({
            propertyId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
            roomTypeId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
            type: commissionTypeSchema,
            value: t.Integer({ minimum: 0 }),
            effectiveFrom: t.Optional(dateStr),
            effectiveTo: t.Optional(t.Nullable(dateStr)),
            notes: t.Optional(nstr(1000)),
          }),
        },
      )

      .patch(
        "/commission-rules/:id",
        async ({ authUser, params, body }) => {
          const rule = await db.query.commissionRules.findFirst({ where: eq(commissionRules.id, params.id) });
          if (!rule) throw notFound("Commission rule");
          validateCommission(body.type ?? rule.type, body.value ?? rule.value);
          const from = body.effectiveFrom ?? rule.effectiveFrom;
          const to = body.effectiveTo === undefined ? rule.effectiveTo : body.effectiveTo;
          if (to && to < from) throw badRequest("effectiveTo must be after effectiveFrom");
          const [updated] = await db
            .update(commissionRules)
            .set(defined(body))
            .where(eq(commissionRules.id, params.id))
            .returning();
          await audit(authUser, "commission_rule.update", "commission_rule", params.id, body);
          return (await buildCommissionRules([updated]))[0];
        },
        {
          params: t.Object({ id: t.String({ format: "uuid" }) }),
          body: t.Object({
            type: t.Optional(commissionTypeSchema),
            value: t.Optional(t.Integer({ minimum: 0 })),
            effectiveFrom: t.Optional(dateStr),
            effectiveTo: t.Optional(t.Nullable(dateStr)),
            notes: t.Optional(nstr(1000)),
          }),
        },
      )

      .delete(
        "/commission-rules/:id",
        async ({ authUser, params }) => {
          const [deleted] = await db.delete(commissionRules).where(eq(commissionRules.id, params.id)).returning();
          if (!deleted) throw notFound("Commission rule");
          await audit(authUser, "commission_rule.delete", "commission_rule", params.id, deleted);
          return { ok: true };
        },
        { params: t.Object({ id: t.String({ format: "uuid" }) }) },
      ),
  );

