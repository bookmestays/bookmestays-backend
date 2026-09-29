// Minimal PropertyCard / ExperienceCard builders (used by the wishlist).
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { amenities, areas, cities, experiences, media, properties, propertyAmenities } from "../db/schema";

export async function propertyCards(ids: string[]) {
  if (!ids.length) return [];
  const rows = await db
    .select({ p: properties, cityName: cities.name, citySlug: cities.slug, areaName: areas.name })
    .from(properties)
    .leftJoin(cities, eq(cities.id, properties.cityId))
    .leftJoin(areas, eq(areas.id, properties.areaId))
    .where(and(inArray(properties.id, ids), eq(properties.status, "LIVE")));
  const am = await db
    .select({ propertyId: propertyAmenities.propertyId, code: amenities.code, name: amenities.name, icon: amenities.icon })
    .from(propertyAmenities)
    .innerJoin(amenities, eq(amenities.id, propertyAmenities.amenityId))
    .where(inArray(propertyAmenities.propertyId, ids))
    .orderBy(asc(amenities.sort));
  const byId = new Map(
    rows.map(({ p, cityName, citySlug, areaName }) => [
      p.id,
      {
        id: p.id,
        slug: p.slug,
        name: p.name,
        type: p.type,
        travelTags: p.travelTags,
        cityName,
        citySlug,
        areaName,
        starRating: p.starRating,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        price: p.startingPrice,
        coverImageUrl: p.coverImageUrl,
        previewVideoUrl: p.previewVideoUrl,
        previewVideoPosterUrl: p.previewVideoPosterUrl,
        highlights: p.highlights,
        amenities: am
          .filter((a) => a.propertyId === p.id)
          .slice(0, 4)
          .map(({ code, name, icon }) => ({ code, name, icon })),
        lat: p.lat,
        lng: p.lng,
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((c) => c !== undefined);
}

export async function experienceCards(ids: string[]) {
  if (!ids.length) return [];
  const rows = await db
    .select({ e: experiences, cityName: cities.name, citySlug: cities.slug })
    .from(experiences)
    .leftJoin(cities, eq(cities.id, experiences.cityId))
    .where(and(inArray(experiences.id, ids), eq(experiences.isActive, true)));
  const videos = await db
    .select({ ownerId: media.ownerId, url: media.url })
    .from(media)
    .where(and(eq(media.ownerType, "EXPERIENCE"), eq(media.kind, "VIDEO"), inArray(media.ownerId, ids)))
    .orderBy(asc(media.sort));
  const byId = new Map(
    rows.map(({ e, cityName, citySlug }) => [
      e.id,
      {
        id: e.id,
        slug: e.slug,
        title: e.title,
        shortDescription: e.shortDescription,
        cityName,
        citySlug,
        durationMinutes: e.durationMinutes,
        price: e.price,
        coverImageUrl: e.coverImageUrl,
        previewVideoUrl: videos.find((v) => v.ownerId === e.id)?.url ?? null,
        ratingAvg: e.ratingAvg,
        ratingCount: e.ratingCount,
        isBookable: e.isBookable,
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((c) => c !== undefined);
}
