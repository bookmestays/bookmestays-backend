// Admin: property listing, creation on a partner's behalf, curation, approval workflow, room-type approval.
import { and, count, desc, eq, ilike, ne, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { commissionRules, partners, properties, roomTypes } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { notifyLater, sendEmail } from "../../lib/notify";
import { pageParams, paginated, slugify } from "../../lib/utils";
import { createPropertyShell } from "../../services/catalog/accounts";
import { recomputeStartingPrice } from "../../services/catalog/maintenance";
import {
  buildAdminPropertyRows,
  partnerPropertyDetail,
  partnerPropertyDetailById,
} from "../../services/catalog/property-detail";
import { setPropertyAmenities, validateLocation } from "../../services/catalog/property-ops";
import {
  commissionTypeSchema,
  defined,
  nstr,
  pageQuery,
  propertyContentFields,
  propertyTypeSchema,
  seoSchema,
} from "./schemas";

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const statusSchema = t.Union(
  (["DRAFT", "PENDING_REVIEW", "LIVE", "REJECTED", "SUSPENDED"] as const).map((s) => t.Literal(s)),
);

async function loadProperty(id: string) {
  const p = await db.query.properties.findFirst({ where: eq(properties.id, id) });
  if (!p) throw notFound("Property");
  return p;
}

async function notifyPartner(partnerId: string, subject: string, text: string) {
  const partner = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
  if (partner) notifyLater(sendEmail({ to: partner.email, subject, text, html: `<p>${text.replace(/\n/g, "<br/>")}</p>` }));
}

const curationFields = {
  isFeatured: t.Optional(t.Boolean()),
  isRecommended: t.Optional(t.Boolean()),
  curationRank: t.Optional(t.Integer()),
  seo: t.Optional(t.Nullable(seoSchema)),
  slug: t.Optional(t.String({ minLength: 2, maxLength: 220 })),
  amenityIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 200 })),
};

export const adminProperties = new Elysia({ name: "admin-properties" })
  .use(authPlugin)
  .guard({ auth: ADMIN_ROLES }, (app) =>
    app
      .get(
        "/properties",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const q = query.q?.trim();
          const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
          const where = and(
            query.status ? eq(properties.status, query.status) : undefined,
            query.partnerId ? eq(properties.partnerId, query.partnerId) : undefined,
            query.cityId ? eq(properties.cityId, query.cityId) : undefined,
            query.type ? eq(properties.type, query.type as never) : undefined,
            like ? or(ilike(properties.name, like), ilike(properties.slug, like)) : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(properties).where(where).orderBy(desc(properties.updatedAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(properties).where(where),
          ]);
          return paginated(await buildAdminPropertyRows(rows), n, page, limit);
        },
        {
          query: t.Object({
            status: t.Optional(statusSchema),
            partnerId: t.Optional(t.String({ format: "uuid" })),
            cityId: t.Optional(t.String({ format: "uuid" })),
            type: t.Optional(t.String()),
            q: t.Optional(t.String()),
            ...pageQuery,
          }),
        },
      )

      .post(
        "/properties",
        async ({ authUser, body }) => {
          const partner = await db.query.partners.findFirst({ where: eq(partners.id, body.partnerId) });
          if (!partner) throw badRequest("Partner does not exist");
          await validateLocation(body.cityId, body.areaId);
          const { partnerId: _pid, amenityIds, isFeatured, isRecommended, curationRank, seo, slug: _slug, ...content } = body;
          const row = await db.transaction(async (tx) => {
            const p = await createPropertyShell(tx, partner, {
              ...defined(content),
              name: body.name,
              ...defined({ isFeatured, isRecommended, curationRank, seo }),
            });
            if (amenityIds) await setPropertyAmenities(p.id, amenityIds, tx);
            return p;
          });
          await audit(authUser, "property.create", "property", row.id, { partnerId: partner.id, name: row.name });
          // PropertyDetail-compatible: PartnerPropertyDetail + empty review/experience blocks.
          return {
            ...(await partnerPropertyDetail(row)),
            experiences: [],
            topReviews: [],
            reviewSummary: { avg: 0, count: 0, distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
          };
        },
        {
          body: t.Object({
            ...propertyContentFields,
            ...curationFields,
            partnerId: t.String({ format: "uuid" }),
            name: t.String({ minLength: 2, maxLength: 200 }),
            type: propertyTypeSchema,
            cityId: t.String({ format: "uuid" }),
          }),
        },
      )

      .get("/properties/:id", async ({ params }) => partnerPropertyDetailById(params.id), { params: idParams })

      .patch(
        "/properties/:id",
        async ({ authUser, params, body }) => {
          const p = await loadProperty(params.id);
          const cityId = body.cityId === undefined ? p.cityId : body.cityId;
          const areaId = body.areaId === undefined ? (body.cityId !== undefined && body.cityId !== p.cityId ? null : p.areaId) : body.areaId;
          await validateLocation(cityId, areaId);
          const { amenityIds, slug, ...rest } = body;
          let newSlug: string | undefined;
          if (slug !== undefined) {
            newSlug = slugify(slug);
            if (!newSlug) throw badRequest("Invalid slug");
            const clash = await db.query.properties.findFirst({
              where: and(eq(properties.slug, newSlug), ne(properties.id, p.id)),
            });
            if (clash) throw conflict("Another property already uses this URL slug");
          }
          await db.transaction(async (tx) => {
            const cols = defined({ ...rest, areaId, slug: newSlug });
            if (Object.keys(cols).length) await tx.update(properties).set(cols).where(eq(properties.id, p.id));
            if (amenityIds) await setPropertyAmenities(p.id, amenityIds, tx);
          });
          await audit(authUser, "property.update", "property", p.id, body);
          return partnerPropertyDetailById(p.id);
        },
        { params: idParams, body: t.Object({ ...propertyContentFields, ...curationFields }) },
      )

      .post(
        "/properties/:id/review",
        async ({ authUser, params, body }) => {
          const p = await loadProperty(params.id);
          const notes = body.notes ?? null;
          switch (body.action) {
            case "APPROVE": {
              if (p.status === "LIVE") throw conflict("Property is already live");
              if (p.status === "SUSPENDED") throw conflict("Use UNSUSPEND to restore a suspended property");
              await db.transaction(async (tx) => {
                // Room types submitted with the property are approved together with it.
                await tx
                  .update(roomTypes)
                  .set({ status: "ACTIVE" })
                  .where(and(eq(roomTypes.propertyId, p.id), eq(roomTypes.status, "PENDING_APPROVAL")));
                await tx
                  .update(properties)
                  .set({ status: "LIVE", reviewNotes: notes, publishedAt: p.publishedAt ?? new Date() })
                  .where(eq(properties.id, p.id));
                await recomputeStartingPrice(p.id, tx);
              });
              await notifyPartner(p.partnerId, `${p.name} is now live on BookMeStays`, `Good news! ${p.name} has been approved and is now live.${notes ? `\nNotes: ${notes}` : ""}`);
              break;
            }
            case "REJECT":
              if (p.status === "LIVE") throw conflict("A live property cannot be rejected — suspend it instead");
              if (!notes) throw badRequest("Please add notes explaining what needs to change");
              await db.update(properties).set({ status: "REJECTED", reviewNotes: notes }).where(eq(properties.id, p.id));
              await notifyPartner(p.partnerId, `${p.name} needs changes`, `${p.name} was not approved yet.\nNotes: ${notes}`);
              break;
            case "SUSPEND":
              if (p.status !== "LIVE") throw conflict("Only live properties can be suspended");
              await db.update(properties).set({ status: "SUSPENDED", reviewNotes: notes }).where(eq(properties.id, p.id));
              await notifyPartner(p.partnerId, `${p.name} has been suspended`, `${p.name} has been suspended and is hidden from guests.${notes ? `\nReason: ${notes}` : ""}`);
              break;
            case "UNSUSPEND":
              if (p.status !== "SUSPENDED") throw conflict("Property is not suspended");
              await db.update(properties).set({ status: "LIVE", reviewNotes: notes }).where(eq(properties.id, p.id));
              await notifyPartner(p.partnerId, `${p.name} is live again`, `${p.name} has been restored and is visible to guests again.`);
              break;
          }
          await audit(authUser, `property.${body.action.toLowerCase()}`, "property", p.id, { notes, from: p.status });
          return partnerPropertyDetailById(p.id);
        },
        {
          params: idParams,
          body: t.Object({
            action: t.Union([t.Literal("APPROVE"), t.Literal("REJECT"), t.Literal("SUSPEND"), t.Literal("UNSUSPEND")]),
            notes: t.Optional(nstr(2000)),
          }),
        },
      )

      .post(
        "/room-types/:id/review",
        async ({ authUser, params, body }) => {
          const [row] = await db
            .select({ rt: roomTypes, partnerId: properties.partnerId, propertyName: properties.name })
            .from(roomTypes)
            .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
            .where(eq(roomTypes.id, params.id));
          if (!row) throw notFound("Room type");
          const { rt } = row;
          if (body.commission?.type === "PERCENT" && body.commission.value > 10_000)
            throw badRequest("Commission percentage cannot exceed 100% (10000 bps)");
          await db.transaction(async (tx) => {
            await tx
              .update(roomTypes)
              .set({ status: body.action === "APPROVE" ? "ACTIVE" : "INACTIVE" })
              .where(eq(roomTypes.id, rt.id));
            if (body.action === "APPROVE" && body.commission)
              await tx.insert(commissionRules).values({
                partnerId: row.partnerId,
                propertyId: rt.propertyId,
                roomTypeId: rt.id,
                type: body.commission.type,
                value: body.commission.value,
                notes: body.notes ?? `Set on approval of ${rt.name}`,
                createdBy: authUser.id,
              });
            await recomputeStartingPrice(rt.propertyId, tx);
          });
          await notifyPartner(
            row.partnerId,
            `Room type ${body.action === "APPROVE" ? "approved" : "not approved"}: ${rt.name}`,
            `${rt.name} at ${row.propertyName} was ${body.action === "APPROVE" ? "approved and is now bookable" : "not approved"}.${body.notes ? `\nNotes: ${body.notes}` : ""}`,
          );
          await audit(authUser, `room_type.${body.action.toLowerCase()}`, "room_type", rt.id, body);
          return partnerPropertyDetailById(rt.propertyId);
        },
        {
          params: idParams,
          body: t.Object({
            action: t.Union([t.Literal("APPROVE"), t.Literal("REJECT")]),
            commission: t.Optional(t.Object({ type: commissionTypeSchema, value: t.Integer({ minimum: 0 }) })),
            notes: t.Optional(t.String({ maxLength: 2000 })),
          }),
        },
      ),
  );
