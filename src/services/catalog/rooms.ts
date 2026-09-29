// Room type + rate plan writes shared by the partner extranet and the admin panel.
// Every write keeps properties.startingPrice in sync; booked room types / rate plans are deactivated
// instead of deleted so booking history keeps its references. Callers audit-log.
import { and, count, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { bookingRooms, media, ratePlans, roomTypes } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { defined } from "../../modules/admin/schemas";
import { recomputeStartingPrice } from "./maintenance";
import { normalizeOccupancy, setRoomTypeAmenities } from "./property-ops";
import { deleteObject } from "./storage";

type RoomTypeRow = typeof roomTypes.$inferSelect;
type RatePlanRow = typeof ratePlans.$inferSelect;
type RoomTypeStatus = RoomTypeRow["status"];
type RatePlanInput = Omit<typeof ratePlans.$inferInsert, "id" | "roomTypeId" | "createdAt" | "updatedAt">;

export type RoomTypeInput = {
  name: string;
  description?: string | null;
  maxAdults: number;
  maxChildren?: number;
  maxOccupancy?: number;
  bedConfig?: string | null;
  sizeSqft?: number | null;
  viewType?: string | null;
  totalRooms: number;
  basePrice: number;
  sort?: number;
  amenityIds?: string[];
  ratePlans?: RatePlanInput[];
};

export async function createRoomType(propertyId: string, body: RoomTypeInput, status: RoomTypeStatus) {
  const occupancy = normalizeOccupancy(body);
  const { amenityIds, ratePlans: plans, ...fields } = body;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(roomTypes)
      .values({ ...defined(fields), ...occupancy, propertyId, status })
      .returning();
    if (amenityIds) await setRoomTypeAmenities(row.id, amenityIds, tx);
    if (plans?.length)
      await tx.insert(ratePlans).values(plans.map((plan, i) => ({ sort: i, ...defined(plan), roomTypeId: row.id })));
    if (status === "ACTIVE") await recomputeStartingPrice(propertyId, tx);
    return row;
  });
}

export async function updateRoomType(
  rt: RoomTypeRow,
  body: Partial<Omit<RoomTypeInput, "ratePlans">>,
  nextStatus?: RoomTypeStatus,
) {
  const occupancy =
    body.maxAdults !== undefined || body.maxChildren !== undefined || body.maxOccupancy !== undefined
      ? normalizeOccupancy({
          maxAdults: body.maxAdults ?? rt.maxAdults,
          maxChildren: body.maxChildren ?? rt.maxChildren,
          maxOccupancy:
            body.maxOccupancy ??
            (body.maxAdults !== undefined || body.maxChildren !== undefined
              ? Math.max(rt.maxOccupancy, (body.maxAdults ?? rt.maxAdults) + (body.maxChildren ?? rt.maxChildren))
              : rt.maxOccupancy),
        })
      : {};
  const { amenityIds, ...fields } = body;
  await db.transaction(async (tx) => {
    const cols = defined({ ...fields, ...occupancy, status: nextStatus });
    if (Object.keys(cols).length) await tx.update(roomTypes).set(cols).where(eq(roomTypes.id, rt.id));
    if (amenityIds) await setRoomTypeAmenities(rt.id, amenityIds, tx);
    await recomputeStartingPrice(rt.propertyId, tx);
  });
}

/** Deletes an unbooked room type (and its media); booked ones are set INACTIVE. */
export async function deleteRoomType(rt: RoomTypeRow) {
  const [{ n }] = await db.select({ n: count() }).from(bookingRooms).where(eq(bookingRooms.roomTypeId, rt.id));
  let removedKeys: string[] = [];
  await db.transaction(async (tx) => {
    if (n > 0) {
      await tx.update(roomTypes).set({ status: "INACTIVE" }).where(eq(roomTypes.id, rt.id));
    } else {
      removedKeys = (
        await tx
          .delete(media)
          .where(and(eq(media.ownerType, "ROOM_TYPE"), eq(media.ownerId, rt.id)))
          .returning({ s3Key: media.s3Key })
      ).map((m) => m.s3Key);
      await tx.delete(roomTypes).where(eq(roomTypes.id, rt.id));
    }
    await recomputeStartingPrice(rt.propertyId, tx);
  });
  for (const key of removedKeys) void deleteObject(key);
  return { deactivated: n > 0 };
}

export async function createRatePlan(rt: RoomTypeRow, body: RatePlanInput) {
  return db.transaction(async (tx) => {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${ratePlans.sort}) + 1, 0)`.mapWith(Number) })
      .from(ratePlans)
      .where(eq(ratePlans.roomTypeId, rt.id));
    const [row] = await tx
      .insert(ratePlans)
      .values({ sort: next, ...defined(body), roomTypeId: rt.id })
      .returning();
    await recomputeStartingPrice(rt.propertyId, tx);
    return row;
  });
}

export async function updateRatePlan(plan: RatePlanRow, rt: RoomTypeRow, body: Partial<RatePlanInput>) {
  return db.transaction(async (tx) => {
    const cols = defined(body);
    const [row] = Object.keys(cols).length
      ? await tx.update(ratePlans).set(cols).where(eq(ratePlans.id, plan.id)).returning()
      : [plan];
    await recomputeStartingPrice(rt.propertyId, tx);
    return row;
  });
}

/** Deletes an unbooked rate plan; booked ones are deactivated. An active room type keeps ≥ 1 plan. */
export async function deleteRatePlan(plan: RatePlanRow, rt: RoomTypeRow) {
  const [{ n }] = await db.select({ n: count() }).from(bookingRooms).where(eq(bookingRooms.ratePlanId, plan.id));
  if (n === 0) {
    const [{ others }] = await db
      .select({ others: count() })
      .from(ratePlans)
      .where(and(eq(ratePlans.roomTypeId, rt.id), sql`${ratePlans.id} <> ${plan.id}`));
    if (others === 0 && rt.status === "ACTIVE")
      throw badRequest("An active room type needs at least one rate plan — deactivate the room type instead");
  }
  await db.transaction(async (tx) => {
    if (n > 0) await tx.update(ratePlans).set({ isActive: false }).where(eq(ratePlans.id, plan.id));
    else await tx.delete(ratePlans).where(eq(ratePlans.id, plan.id));
    await recomputeStartingPrice(rt.propertyId, tx);
  });
  return { deactivated: n > 0 };
}
