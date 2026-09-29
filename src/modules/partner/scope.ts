// Partner scoping: every lookup is filtered by the caller's partnerId; foreign ids → 404.
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { nearbyPlaces, properties, ratePlans, roomTypes } from "../../db/schema";
import { notFound } from "../../lib/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ownProperty(partnerId: string, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Property");
  const p = await db.query.properties.findFirst({ where: and(eq(properties.id, id), eq(properties.partnerId, partnerId)) });
  if (!p) throw notFound("Property");
  return p;
}

export async function ownRoomType(partnerId: string, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Room type");
  const [row] = await db
    .select({ rt: roomTypes, property: properties })
    .from(roomTypes)
    .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
    .where(and(eq(roomTypes.id, id), eq(properties.partnerId, partnerId)));
  if (!row) throw notFound("Room type");
  return row;
}

export async function ownRatePlan(partnerId: string, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Rate plan");
  const [row] = await db
    .select({ plan: ratePlans, rt: roomTypes, property: properties })
    .from(ratePlans)
    .innerJoin(roomTypes, eq(roomTypes.id, ratePlans.roomTypeId))
    .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
    .where(and(eq(ratePlans.id, id), eq(properties.partnerId, partnerId)));
  if (!row) throw notFound("Rate plan");
  return row;
}

export async function ownNearby(partnerId: string, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Nearby place");
  const [row] = await db
    .select({ nearby: nearbyPlaces, property: properties })
    .from(nearbyPlaces)
    .innerJoin(properties, eq(properties.id, nearbyPlaces.propertyId))
    .where(and(eq(nearbyPlaces.id, id), eq(properties.partnerId, partnerId)));
  if (!row) throw notFound("Nearby place");
  return row;
}
