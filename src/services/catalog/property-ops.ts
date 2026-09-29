// Write helpers shared by admin + partner property/room management.
import { eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../../db";
import { amenities, areas, cities, propertyAmenities, roomTypeAmenities } from "../../db/schema";
import { badRequest } from "../../lib/errors";

type Exec = typeof db | Tx;

/** Validates that city exists and area (if any) belongs to it. */
export async function validateLocation(cityId: string | null | undefined, areaId: string | null | undefined) {
  if (cityId) {
    const c = await db.query.cities.findFirst({ where: eq(cities.id, cityId) });
    if (!c) throw badRequest("Selected city does not exist");
  }
  if (areaId) {
    const a = await db.query.areas.findFirst({ where: eq(areas.id, areaId) });
    if (!a) throw badRequest("Selected area does not exist");
    if (cityId && a.cityId !== cityId) throw badRequest("Selected area is not in the selected city");
    if (!cityId) throw badRequest("Choose a city before choosing an area");
  }
}

async function validAmenityIds(ids: string[], scope: "PROPERTY" | "ROOM") {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select().from(amenities).where(inArray(amenities.id, unique));
  if (rows.length !== unique.length) throw badRequest("Some amenities do not exist");
  const wrong = rows.filter((a) => a.scope !== "BOTH" && a.scope !== scope);
  if (wrong.length)
    throw badRequest(
      `These amenities are for ${scope === "PROPERTY" ? "rooms" : "properties"}: ${wrong.map((a) => a.name).join(", ")}`,
    );
  return unique;
}

export async function setPropertyAmenities(propertyId: string, ids: string[], exec: Exec = db) {
  const valid = await validAmenityIds(ids, "PROPERTY");
  await exec.delete(propertyAmenities).where(eq(propertyAmenities.propertyId, propertyId));
  if (valid.length) await exec.insert(propertyAmenities).values(valid.map((amenityId) => ({ propertyId, amenityId })));
}

export async function setRoomTypeAmenities(roomTypeId: string, ids: string[], exec: Exec = db) {
  const valid = await validAmenityIds(ids, "ROOM");
  await exec.delete(roomTypeAmenities).where(eq(roomTypeAmenities.roomTypeId, roomTypeId));
  if (valid.length) await exec.insert(roomTypeAmenities).values(valid.map((amenityId) => ({ roomTypeId, amenityId })));
}

/** Occupancy sanity: maxOccupancy defaults to adults + children and must hold maxAdults. */
export function normalizeOccupancy(o: { maxAdults: number; maxChildren?: number; maxOccupancy?: number }) {
  const maxChildren = o.maxChildren ?? 0;
  const maxOccupancy = o.maxOccupancy ?? o.maxAdults + maxChildren;
  if (maxOccupancy < o.maxAdults) throw badRequest("Max occupancy cannot be less than max adults");
  return { maxAdults: o.maxAdults, maxChildren, maxOccupancy };
}

