// Batch builders for the list/card DTOs (PropertyCard, ExperienceCard, CityCard, CollectionCard, VideoFeedItem).
// Every builder takes a list of rows and issues a constant number of queries (no N+1).
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { getRankingSettings } from "../settings";
import {
  amenities,
  areas,
  cities,
  collectionItems,
  collections,
  experiences,
  media,
  properties,
  propertyAmenities,
} from "../../db/schema";
import { groupBy, toMedia, uniq } from "./dto";

export type PropertyRow = typeof properties.$inferSelect;
type ExperienceRow = typeof experiences.$inferSelect;
type CityRow = typeof cities.$inferSelect;
type CollectionRow = typeof collections.$inferSelect;

export const LIVE = eq(properties.status, "LIVE");

async function cityAreaMaps(cityIds: string[], areaIds: string[]) {
  const [cityRows, areaRows] = await Promise.all([
    cityIds.length ? db.select().from(cities).where(inArray(cities.id, cityIds)) : [],
    areaIds.length ? db.select().from(areas).where(inArray(areas.id, areaIds)) : [],
  ]);
  return { cityMap: new Map(cityRows.map((c) => [c.id, c])), areaMap: new Map(areaRows.map((a) => [a.id, a])) };
}

/** PropertyCard[] in the same order as `rows`. `priceOverride` replaces startingPrice (date-specific search). */
export async function buildPropertyCards(rows: PropertyRow[], priceOverride?: Map<string, number>) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [{ cityMap, areaMap }, amenityRows] = await Promise.all([
    cityAreaMaps(uniq(rows.map((r) => r.cityId)), uniq(rows.map((r) => r.areaId))),
    db
      .select({ propertyId: propertyAmenities.propertyId, code: amenities.code, name: amenities.name, icon: amenities.icon })
      .from(propertyAmenities)
      .innerJoin(amenities, eq(amenities.id, propertyAmenities.amenityId))
      .where(inArray(propertyAmenities.propertyId, ids))
      .orderBy(asc(amenities.sort), asc(amenities.name)),
  ]);
  const amenityMap = groupBy(amenityRows, (a) => a.propertyId);
  return rows.map((p) => {
    const city = p.cityId ? cityMap.get(p.cityId) : undefined;
    const area = p.areaId ? areaMap.get(p.areaId) : undefined;
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: p.type,
      travelTags: p.travelTags,
      cityName: city?.name ?? null,
      citySlug: city?.slug ?? null,
      areaName: area?.name ?? null,
      starRating: p.starRating,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      price: priceOverride?.get(p.id) ?? p.startingPrice ?? null,
      coverImageUrl: p.coverImageUrl,
      previewVideoUrl: p.previewVideoUrl,
      previewVideoPosterUrl: p.previewVideoPosterUrl,
      highlights: p.highlights,
      amenities: (amenityMap.get(p.id) ?? []).slice(0, 4).map(({ code, name, icon }) => ({ code, name, icon })),
      lat: p.lat,
      lng: p.lng,
    };
  });
}
export type PropertyCardDto = Awaited<ReturnType<typeof buildPropertyCards>>[number];

/** Cards for the given ids (order preserved; missing / non-live ids dropped unless `anyStatus`). */
export async function propertyCardsByIds(ids: string[], opts: { anyStatus?: boolean; priceOverride?: Map<string, number> } = {}) {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(properties)
    .where(and(inArray(properties.id, ids), opts.anyStatus ? undefined : LIVE));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return buildPropertyCards(
    ids.map((id) => byId.get(id)).filter((r): r is PropertyRow => !!r),
    opts.priceOverride,
  );
}

/** Admin's manual order first, popularity breaking ties. */
const PINS_FIRST_ORDER = [
  desc(properties.isFeatured),
  desc(properties.isRecommended),
  desc(properties.curationRank),
  desc(properties.popularityScore),
  desc(properties.ratingAvg),
  desc(properties.ratingCount),
  asc(properties.name),
];
/** Most-booked stays first (completed stays − 0.5 × cancellations), admin rank breaking ties. */
const MOST_BOOKED_ORDER = [
  desc(properties.popularityScore),
  desc(properties.completedBookings),
  desc(properties.curationRank),
  desc(properties.ratingAvg),
  desc(properties.ratingCount),
  asc(properties.name),
];

/** Default "best first" ordering for curated property lists (admin setting decides). */
export async function curatedOrder() {
  const { mode } = await getRankingSettings();
  return mode === "PINS_FIRST" ? PINS_FIRST_ORDER : MOST_BOOKED_ORDER;
}

export async function livePropertyCards(where: SQL | undefined, limit: number, orderBy?: SQL[]) {
  const order = orderBy ?? (await curatedOrder());
  const rows = await db
    .select()
    .from(properties)
    .where(and(LIVE, where))
    .orderBy(...order)
    .limit(limit);
  return buildPropertyCards(rows);
}

// ─── Experiences ──────────────────────────────────────────────────────────────

export async function buildExperienceCards(rows: ExperienceRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [{ cityMap }, videos] = await Promise.all([
    cityAreaMaps(uniq(rows.map((r) => r.cityId)), []),
    db
      .select({ ownerId: media.ownerId, url: media.url })
      .from(media)
      .where(and(eq(media.ownerType, "EXPERIENCE"), eq(media.kind, "VIDEO"), inArray(media.ownerId, ids)))
      .orderBy(desc(media.isCover), asc(media.sort), asc(media.createdAt)),
  ]);
  const videoMap = new Map<string, string>();
  for (const v of videos) if (v.ownerId && !videoMap.has(v.ownerId)) videoMap.set(v.ownerId, v.url);
  return rows.map((e) => {
    const city = e.cityId ? cityMap.get(e.cityId) : undefined;
    return {
      id: e.id,
      slug: e.slug,
      title: e.title,
      shortDescription: e.shortDescription,
      cityName: city?.name ?? null,
      citySlug: city?.slug ?? null,
      durationMinutes: e.durationMinutes,
      price: e.price,
      coverImageUrl: e.coverImageUrl,
      previewVideoUrl: videoMap.get(e.id) ?? null,
      ratingAvg: e.ratingAvg,
      ratingCount: e.ratingCount,
      isBookable: e.isBookable,
    };
  });
}
export type ExperienceCardDto = Awaited<ReturnType<typeof buildExperienceCards>>[number];

export async function activeExperienceCards(where: SQL | undefined, limit: number) {
  const rows = await db
    .select()
    .from(experiences)
    .where(and(eq(experiences.isActive, true), where))
    .orderBy(asc(experiences.sort), desc(experiences.ratingAvg), asc(experiences.title))
    .limit(limit);
  return buildExperienceCards(rows);
}

// ─── Cities ───────────────────────────────────────────────────────────────────

export async function buildCityCards(rows: CityRow[]) {
  if (!rows.length) return [];
  const counts = await db
    .select({ cityId: properties.cityId, n: count() })
    .from(properties)
    .where(and(LIVE, inArray(properties.cityId, rows.map((c) => c.id))))
    .groupBy(properties.cityId);
  const countMap = new Map(counts.map((c) => [c.cityId, c.n]));
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    state: c.state,
    coverImageUrl: c.coverImageUrl,
    intro: c.intro,
    propertyCount: countMap.get(c.id) ?? 0,
    isFeatured: c.isFeatured,
  }));
}
export type CityCardDto = Awaited<ReturnType<typeof buildCityCards>>[number];

export const cityOrder = [desc(cities.isFeatured), asc(cities.sort), asc(cities.name)];

// ─── Collections ──────────────────────────────────────────────────────────────

export async function buildCollectionCards(rows: CollectionRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [counts, { cityMap }] = await Promise.all([
    db
      .select({ collectionId: collectionItems.collectionId, n: count() })
      .from(collectionItems)
      .innerJoin(properties, eq(properties.id, collectionItems.propertyId))
      .where(and(LIVE, inArray(collectionItems.collectionId, ids)))
      .groupBy(collectionItems.collectionId),
    cityAreaMaps(uniq(rows.map((r) => r.cityId)), []),
  ]);
  const countMap = new Map(counts.map((c) => [c.collectionId, c.n]));
  return rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    description: c.description,
    coverImageUrl: c.coverImageUrl,
    citySlug: c.cityId ? (cityMap.get(c.cityId)?.slug ?? null) : null,
    propertyCount: countMap.get(c.id) ?? 0,
  }));
}
export type CollectionCardDto = Awaited<ReturnType<typeof buildCollectionCards>>[number];

export async function activeCollectionCards(where: SQL | undefined, limit: number) {
  const rows = await db
    .select()
    .from(collections)
    .where(and(eq(collections.isActive, true), where))
    .orderBy(asc(collections.sort), asc(collections.title))
    .limit(limit);
  return buildCollectionCards(rows);
}

// ─── Video discovery feed ─────────────────────────────────────────────────────

/** Property videos of LIVE properties → VideoFeedItem[]. At most `perProperty` videos per stay for variety. */
export async function videoFeed(opts: { cityId?: string; type?: string; limit: number; perProperty?: number }) {
  const perProperty = opts.perProperty ?? 2;
  const filters: SQL[] = [sql`p.status = 'LIVE'`, sql`m.owner_type = 'PROPERTY'`, sql`m.kind = 'VIDEO'`];
  if (opts.cityId) filters.push(sql`p.city_id = ${opts.cityId}`);
  if (opts.type) filters.push(sql`p.type = ${opts.type}`);
  const ranked = await db.execute<{ id: string; property_id: string }>(sql`
    SELECT id, property_id FROM (
      SELECT m.id, p.id AS property_id, p.is_featured, p.curation_rank, p.rating_avg, m.sort,
             row_number() OVER (PARTITION BY p.id ORDER BY m.is_cover DESC, m.sort, m.created_at) AS rn
      FROM media m JOIN properties p ON p.id = m.owner_id
      WHERE ${sql.join(filters, sql` AND `)}
    ) x
    WHERE rn <= ${perProperty}
    ORDER BY rn, is_featured DESC, curation_rank DESC, rating_avg DESC, sort
    LIMIT ${opts.limit}
  `);
  const list = [...ranked];
  if (!list.length) return [];
  const [mediaRows, cards] = await Promise.all([
    db.select().from(media).where(inArray(media.id, list.map((r) => r.id))),
    propertyCardsByIds(uniq(list.map((r) => r.property_id))),
  ]);
  const mediaMap = new Map(mediaRows.map((m) => [m.id, m]));
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  return list.flatMap((r) => {
    const m = mediaMap.get(r.id);
    const property = cardMap.get(r.property_id);
    return m && property ? [{ media: toMedia(m), property }] : [];
  });
}
