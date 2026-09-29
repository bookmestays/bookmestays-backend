// Partner: room types (+amenities) and rate plans. Keeps properties.startingPrice in sync.
// The write logic lives in services/catalog/rooms.ts (shared with the admin panel).
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { audit } from "../../lib/audit";
import { authPlugin } from "../../lib/auth";
import { toRatePlan } from "../../services/catalog/dto";
import { loadRoomTypes, roomTypeDto } from "../../services/catalog/property-detail";
import { setRoomTypeAmenities } from "../../services/catalog/property-ops";
import {
  createRatePlan,
  createRoomType,
  deleteRatePlan,
  deleteRoomType,
  updateRatePlan,
  updateRoomType,
} from "../../services/catalog/rooms";
import { lit, ratePlanFields, roomTypeFields } from "../admin/schemas";
import { ownProperty, ownRatePlan, ownRoomType } from "./scope";

const idParams = t.Object({ id: t.String() });
const amenityIds = t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 100 }));

export const partnerRooms = new Elysia({ name: "partner-rooms" })
  .use(authPlugin)

  .get(
    "/properties/:id/room-types",
    async ({ partnerId, params }) => {
      const p = await ownProperty(partnerId, params.id);
      return (await loadRoomTypes([p.id])).get(p.id) ?? [];
    },
    { partner: true, params: idParams },
  )

  .post(
    "/properties/:id/room-types",
    async ({ authUser, partnerId, params, body }) => {
      const p = await ownProperty(partnerId, params.id);
      const rt = await createRoomType(p.id, body, "PENDING_APPROVAL");
      await audit(authUser, "room_type.create", "room_type", rt.id, { propertyId: p.id, name: rt.name });
      return roomTypeDto(rt.id);
    },
    {
      partner: "content",
      params: idParams,
      body: t.Object({
        ...roomTypeFields,
        amenityIds,
        ratePlans: t.Optional(t.Array(t.Object(ratePlanFields), { maxItems: 10 })),
      }),
    },
  )

  .patch(
    "/room-types/:id",
    async ({ authUser, partnerId, params, body }) => {
      const { rt } = await ownRoomType(partnerId, params.id);
      const { status, ...fields } = body;
      // Partners can pause a room type; re-activating a paused one goes back through approval.
      let nextStatus: typeof rt.status | undefined;
      if (status === "INACTIVE") nextStatus = "INACTIVE";
      else if (status === "ACTIVE" && rt.status === "INACTIVE") nextStatus = "PENDING_APPROVAL";
      await updateRoomType(rt, fields, nextStatus);
      await audit(authUser, "room_type.update", "room_type", rt.id, body);
      return roomTypeDto(rt.id);
    },
    {
      partner: "content",
      params: idParams,
      body: t.Partial(
        t.Object({
          ...roomTypeFields,
          amenityIds: t.Array(t.String({ format: "uuid" }), { maxItems: 100 }),
          status: lit(["ACTIVE", "INACTIVE"] as const),
        }),
      ),
    },
  )

  .delete(
    "/room-types/:id",
    async ({ authUser, partnerId, params }) => {
      const { rt } = await ownRoomType(partnerId, params.id);
      const { deactivated } = await deleteRoomType(rt);
      await audit(authUser, deactivated ? "room_type.deactivate" : "room_type.delete", "room_type", rt.id, { name: rt.name });
      return { ok: true, deactivated };
    },
    { partner: "content", params: idParams },
  )

  .put(
    "/room-types/:id/amenities",
    async ({ authUser, partnerId, params, body }) => {
      const { rt } = await ownRoomType(partnerId, params.id);
      await db.transaction((tx) => setRoomTypeAmenities(rt.id, body.amenityIds, tx));
      await audit(authUser, "room_type.amenities", "room_type", rt.id, body);
      return roomTypeDto(rt.id);
    },
    {
      partner: "content",
      params: idParams,
      body: t.Object({ amenityIds: t.Array(t.String({ format: "uuid" }), { maxItems: 100 }) }),
    },
  )

  // ─── Rate plans ─────────────────────────────────────────────────────────────
  .post(
    "/room-types/:id/rate-plans",
    async ({ authUser, partnerId, params, body }) => {
      const { rt } = await ownRoomType(partnerId, params.id);
      const plan = await createRatePlan(rt, body);
      await audit(authUser, "rate_plan.create", "rate_plan", plan.id, { roomTypeId: rt.id, ...body });
      return toRatePlan(plan);
    },
    { partner: "content", params: idParams, body: t.Object(ratePlanFields) },
  )

  .patch(
    "/rate-plans/:id",
    async ({ authUser, partnerId, params, body }) => {
      const { plan, rt } = await ownRatePlan(partnerId, params.id);
      const updated = await updateRatePlan(plan, rt, body);
      await audit(authUser, "rate_plan.update", "rate_plan", plan.id, body);
      return toRatePlan(updated);
    },
    { partner: "content", params: idParams, body: t.Partial(t.Object(ratePlanFields)) },
  )

  .delete(
    "/rate-plans/:id",
    async ({ authUser, partnerId, params }) => {
      const { plan, rt } = await ownRatePlan(partnerId, params.id);
      const { deactivated } = await deleteRatePlan(plan, rt);
      await audit(authUser, deactivated ? "rate_plan.deactivate" : "rate_plan.delete", "rate_plan", plan.id, { name: plan.name });
      return { ok: true, deactivated };
    },
    { partner: "content", params: idParams },
  );
