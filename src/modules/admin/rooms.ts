// Admin: room types + rate plans of any property (pending list, create/edit/delete on a partner's behalf).
// Write logic is shared with the partner extranet (services/catalog/rooms.ts); every change is audit-logged.
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { partners, properties, ratePlans, roomTypes } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { notFound } from "../../lib/errors";
import { pageParams, paginated } from "../../lib/utils";
import { toRatePlan } from "../../services/catalog/dto";
import { loadRoomTypes, roomTypeDto } from "../../services/catalog/property-detail";
import {
  createRatePlan,
  createRoomType,
  deleteRatePlan,
  deleteRoomType,
  updateRatePlan,
  updateRoomType,
} from "../../services/catalog/rooms";
import { resolveCommissions } from "../../services/pricing";
import { lit, pageQuery, ratePlanFields, roomTypeFields } from "./schemas";

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const roomTypeStatusSchema = lit(["PENDING_APPROVAL", "ACTIVE", "INACTIVE"] as const);
const amenityIds = t.Array(t.String({ format: "uuid" }), { maxItems: 100 });

async function loadRoomType(id: string) {
  const [row] = await db
    .select({ rt: roomTypes, property: properties })
    .from(roomTypes)
    .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
    .where(eq(roomTypes.id, id));
  if (!row) throw notFound("Room type");
  return row;
}

async function loadRatePlan(id: string) {
  const [row] = await db
    .select({ plan: ratePlans, rt: roomTypes })
    .from(ratePlans)
    .innerJoin(roomTypes, eq(roomTypes.id, ratePlans.roomTypeId))
    .where(eq(ratePlans.id, id));
  if (!row) throw notFound("Rate plan");
  return row;
}

export const adminRooms = new Elysia({ name: "admin-rooms" })
  .use(authPlugin)
  .guard({ auth: ADMIN_ROLES }, (app) =>
    app
      // GET /admin/room-types?status=PENDING_APPROVAL — room types across properties, with their
      // property, partner, rate plans and the commission that currently applies to them.
      .get(
        "/room-types",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const q = query.q?.trim();
          const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
          const where = and(
            query.status ? eq(roomTypes.status, query.status) : undefined,
            query.propertyId ? eq(roomTypes.propertyId, query.propertyId) : undefined,
            query.partnerId ? eq(properties.partnerId, query.partnerId) : undefined,
            like ? or(ilike(roomTypes.name, like), ilike(properties.name, like)) : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db
              .select({ id: roomTypes.id, property: properties, partner: partners, createdAt: roomTypes.createdAt })
              .from(roomTypes)
              .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
              .innerJoin(partners, eq(partners.id, properties.partnerId))
              .where(where)
              .orderBy(desc(roomTypes.createdAt))
              .limit(limit)
              .offset(offset),
            db
              .select({ n: count() })
              .from(roomTypes)
              .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
              .where(where),
          ]);
          const propertyIds = [...new Set(rows.map((r) => r.property.id))];
          const dtoMap = await loadRoomTypes(propertyIds, { roomTypeIds: rows.map((r) => r.id) });
          const dtos = new Map([...dtoMap.values()].flat().map((d) => [d.id, d]));
          // Commission resolution is per property (room type rule → property rule → partner rule → default)
          const commissionByRt = new Map<string, { type: "PERCENT" | "FLAT"; value: number }>();
          await Promise.all(
            propertyIds.map(async (pid) => {
              const inProperty = rows.filter((r) => r.property.id === pid);
              const resolved = await resolveCommissions(db, inProperty[0].partner, pid, inProperty.map((r) => r.id));
              for (const [rtId, term] of resolved) commissionByRt.set(rtId, term);
            }),
          );
          const items = rows
            .filter((r) => dtos.has(r.id))
            .map((r) => ({
              ...dtos.get(r.id)!,
              createdAt: r.createdAt.toISOString(),
              property: { id: r.property.id, name: r.property.name, slug: r.property.slug, status: r.property.status },
              partner: { id: r.partner.id, displayName: r.partner.displayName },
              commission: commissionByRt.get(r.id) ?? null,
            }));
          return paginated(items, n, page, limit);
        },
        {
          query: t.Object({
            status: t.Optional(roomTypeStatusSchema),
            propertyId: t.Optional(t.String({ format: "uuid" })),
            partnerId: t.Optional(t.String({ format: "uuid" })),
            q: t.Optional(t.String()),
            ...pageQuery,
          }),
        },
      )

      .post(
        "/properties/:id/room-types",
        async ({ authUser, params, body }) => {
          const p = await db.query.properties.findFirst({ where: eq(properties.id, params.id) });
          if (!p) throw notFound("Property");
          const { status, ...input } = body;
          // Admin-created room types skip the approval queue unless asked otherwise.
          const rt = await createRoomType(p.id, input, status ?? "ACTIVE");
          await audit(authUser, "room_type.create", "room_type", rt.id, { propertyId: p.id, name: rt.name, status: rt.status, by: "admin" });
          return roomTypeDto(rt.id);
        },
        {
          params: idParams,
          body: t.Object({
            ...roomTypeFields,
            status: t.Optional(roomTypeStatusSchema),
            amenityIds: t.Optional(amenityIds),
            ratePlans: t.Optional(t.Array(t.Object(ratePlanFields), { maxItems: 10 })),
          }),
        },
      )

      .patch(
        "/room-types/:id",
        async ({ authUser, params, body }) => {
          const { rt } = await loadRoomType(params.id);
          const { status, ...fields } = body;
          await updateRoomType(rt, fields, status);
          await audit(authUser, "room_type.update", "room_type", rt.id, { ...body, by: "admin", from: status ? rt.status : undefined });
          return roomTypeDto(rt.id);
        },
        {
          params: idParams,
          body: t.Partial(t.Object({ ...roomTypeFields, amenityIds, status: roomTypeStatusSchema })),
        },
      )

      .delete(
        "/room-types/:id",
        async ({ authUser, params }) => {
          const { rt } = await loadRoomType(params.id);
          const { deactivated } = await deleteRoomType(rt);
          await audit(authUser, deactivated ? "room_type.deactivate" : "room_type.delete", "room_type", rt.id, { name: rt.name, by: "admin" });
          return { ok: true, deactivated };
        },
        { params: idParams },
      )

      .post(
        "/room-types/:id/rate-plans",
        async ({ authUser, params, body }) => {
          const { rt } = await loadRoomType(params.id);
          const plan = await createRatePlan(rt, body);
          await audit(authUser, "rate_plan.create", "rate_plan", plan.id, { roomTypeId: rt.id, ...body, by: "admin" });
          return toRatePlan(plan);
        },
        { params: idParams, body: t.Object(ratePlanFields) },
      )

      .patch(
        "/rate-plans/:id",
        async ({ authUser, params, body }) => {
          const { plan, rt } = await loadRatePlan(params.id);
          const updated = await updateRatePlan(plan, rt, body);
          await audit(authUser, "rate_plan.update", "rate_plan", plan.id, { ...body, by: "admin" });
          return toRatePlan(updated);
        },
        { params: idParams, body: t.Partial(t.Object(ratePlanFields)) },
      )

      .delete(
        "/rate-plans/:id",
        async ({ authUser, params }) => {
          const { plan, rt } = await loadRatePlan(params.id);
          const { deactivated } = await deleteRatePlan(plan, rt);
          await audit(authUser, deactivated ? "rate_plan.deactivate" : "rate_plan.delete", "rate_plan", plan.id, { name: plan.name, by: "admin" });
          return { ok: true, deactivated };
        },
        { params: idParams },
      ),
  );
