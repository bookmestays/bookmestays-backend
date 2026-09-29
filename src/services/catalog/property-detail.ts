// Full property payloads: PropertyDetail (public), PartnerPropertyDetail (partner/admin), property rows.
import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  amenities,
  areas,
  bookings,
  cities,
  experiences,
  media,
  nearbyPlaces,
  partners,
  properties,
  propertyAmenities,
  ratePlans,
  reviews,
  roomTypeAmenities,
  roomTypes,
  users,
} from "../../db/schema";
import { notFound } from "../../lib/errors";
import { buildExperienceCards, buildPropertyCards, type PropertyRow } from "./cards";
import {
  groupBy,
  iso,
  toAmenity,
  toArea,
  toCityLite,
  toMedia,
  toNearbyBase,
  toRatePlan,
  toRoomTypeBase,
  uniq,
  type NearbyDto,
  type RoomTypeDto,
} from "./dto";

const mediaOrder = [desc(media.isCover), asc(media.sort), asc(media.createdAt)];

/** Room types (with amenities, media and rate plans) for many properties at once. */
export async function loadRoomTypes(propertyIds: string[], opts: { publicOnly?: boolean; roomTypeIds?: string[] } = {}) {
  const result = new Map<string, RoomTypeDto[]>();
  if (!propertyIds.length) return result;
  const rts = await db
    .select()
    .from(roomTypes)
    .where(
      and(
        inArray(roomTypes.propertyId, propertyIds),
        opts.publicOnly ? eq(roomTypes.status, "ACTIVE") : undefined,
        opts.roomTypeIds ? inArray(roomTypes.id, opts.roomTypeIds) : undefined,
      ),
    )
    .orderBy(asc(roomTypes.sort), asc(roomTypes.basePrice), asc(roomTypes.createdAt));
  if (!rts.length) return result;
  const rtIds = rts.map((r) => r.id);
  const [plans, amenityRows, mediaRows] = await Promise.all([
    db
      .select()
      .from(ratePlans)
      .where(and(inArray(ratePlans.roomTypeId, rtIds), opts.publicOnly ? eq(ratePlans.isActive, true) : undefined))
      .orderBy(asc(ratePlans.sort), asc(ratePlans.basePrice)),
    db
      .select({ roomTypeId: roomTypeAmenities.roomTypeId, amenity: amenities })
      .from(roomTypeAmenities)
      .innerJoin(amenities, eq(amenities.id, roomTypeAmenities.amenityId))
      .where(inArray(roomTypeAmenities.roomTypeId, rtIds))
      .orderBy(asc(amenities.sort)),
    db
      .select()
      .from(media)
      .where(and(eq(media.ownerType, "ROOM_TYPE"), inArray(media.ownerId, rtIds)))
      .orderBy(...mediaOrder),
  ]);
  const planMap = groupBy(plans, (p) => p.roomTypeId);
  const amenityMap = groupBy(amenityRows, (a) => a.roomTypeId);
  const mediaMap = groupBy(mediaRows, (m) => m.ownerId);
  for (const rt of rts) {
    const dto: RoomTypeDto = {
      ...toRoomTypeBase(rt),
      amenities: (amenityMap.get(rt.id) ?? []).map((a) => toAmenity(a.amenity)),
      media: (mediaMap.get(rt.id) ?? []).map(toMedia),
      ratePlans: (planMap.get(rt.id) ?? []).map(toRatePlan),
    };
    const list = result.get(rt.propertyId);
    if (list) list.push(dto);
    else result.set(rt.propertyId, [dto]);
  }
  return result;
}

/** Single RoomType DTO (all statuses, all rate plans). */
export async function roomTypeDto(roomTypeId: string) {
  const rt = await db.query.roomTypes.findFirst({ where: eq(roomTypes.id, roomTypeId) });
  if (!rt) throw notFound("Room type");
  const map = await loadRoomTypes([rt.propertyId], { roomTypeIds: [rt.id] });
  return map.get(rt.propertyId)![0];
}

export async function loadNearby(propertyId: string): Promise<NearbyDto[]> {
  const rows = await db
    .select()
    .from(nearbyPlaces)
    .where(eq(nearbyPlaces.propertyId, propertyId))
    .orderBy(asc(nearbyPlaces.sort), asc(nearbyPlaces.distanceKm));
  if (!rows.length) return [];
  const mediaRows = await db
    .select()
    .from(media)
    .where(and(eq(media.ownerType, "NEARBY_PLACE"), inArray(media.ownerId, rows.map((r) => r.id))))
    .orderBy(...mediaOrder);
  const mediaMap = groupBy(mediaRows, (m) => m.ownerId);
  return rows.map((n) => ({ ...toNearbyBase(n), media: (mediaMap.get(n.id) ?? []).map(toMedia) }));
}

export async function nearbyDto(id: string): Promise<NearbyDto> {
  const n = await db.query.nearbyPlaces.findFirst({ where: eq(nearbyPlaces.id, id) });
  if (!n) throw notFound("Nearby place");
  const mediaRows = await db
    .select()
    .from(media)
    .where(and(eq(media.ownerType, "NEARBY_PLACE"), eq(media.ownerId, id)))
    .orderBy(...mediaOrder);
  return { ...toNearbyBase(n), media: mediaRows.map(toMedia) };
}

/** Fields shared by PropertyDetail and PartnerPropertyDetail. */
async function propertyCore(p: PropertyRow) {
  const [[card], city, area, amenityRows, mediaRows, nearby] = await Promise.all([
    buildPropertyCards([p]),
    p.cityId ? db.query.cities.findFirst({ where: eq(cities.id, p.cityId) }) : undefined,
    p.areaId ? db.query.areas.findFirst({ where: eq(areas.id, p.areaId) }) : undefined,
    db
      .select({ amenity: amenities })
      .from(propertyAmenities)
      .innerJoin(amenities, eq(amenities.id, propertyAmenities.amenityId))
      .where(eq(propertyAmenities.propertyId, p.id))
      .orderBy(asc(amenities.sort)),
    db
      .select()
      .from(media)
      .where(and(eq(media.ownerType, "PROPERTY"), eq(media.ownerId, p.id)))
      .orderBy(asc(media.sort), asc(media.createdAt)),
    loadNearby(p.id),
  ]);
  const { amenities: _topAmenities, ...cardRest } = card;
  return {
    ...cardRest,
    shortDescription: p.shortDescription,
    description: p.description,
    foodAndDining: p.foodAndDining,
    address: p.address,
    pincode: p.pincode,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    cancellationPolicy: p.cancellationPolicy ?? null,
    houseRules: p.houseRules,
    terms: p.terms,
    city: city ? toCityLite(city) : null,
    area: area ? toArea(area) : null,
    amenities: amenityRows.map((a) => toAmenity(a.amenity)),
    media: mediaRows.map(toMedia),
    nearby,
    seo: p.seo ?? null,
    channelManaged: p.channelManaged,
  };
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

type ReviewRow = typeof reviews.$inferSelect;

const displayName = (name: string | null) => {
  if (!name?.trim()) return "Guest";
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
};

/** Review DTOs (author display name + stay month) for many reviews at once. */
export async function buildReviews(rows: ReviewRow[]) {
  if (!rows.length) return [];
  const [userRows, bookingRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, uniq(rows.map((r) => r.userId)))),
    (() => {
      const ids = uniq(rows.map((r) => r.bookingId));
      return ids.length
        ? db.select({ id: bookings.id, checkIn: bookings.checkIn }).from(bookings).where(inArray(bookings.id, ids))
        : Promise.resolve([] as { id: string; checkIn: string }[]);
    })(),
  ]);
  const nameMap = new Map(userRows.map((u) => [u.id, u.name]));
  const stayMap = new Map(bookingRows.map((b) => [b.id, b.checkIn.slice(0, 7)]));
  return rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    authorName: displayName(nameMap.get(r.userId) ?? null),
    stayMonth: r.bookingId ? (stayMap.get(r.bookingId) ?? null) : null,
    partnerReply: r.partnerReply,
    createdAt: iso(r.createdAt)!,
  }));
}
export type ReviewDto = Awaited<ReturnType<typeof buildReviews>>[number];

export async function reviewSummary(propertyId: string) {
  const rows = await db
    .select({ rating: reviews.rating, n: count() })
    .from(reviews)
    .where(and(eq(reviews.propertyId, propertyId), eq(reviews.status, "PUBLISHED")))
    .groupBy(reviews.rating);
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } as Record<"1" | "2" | "3" | "4" | "5", number>;
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    const k = String(Math.min(5, Math.max(1, r.rating))) as keyof typeof distribution;
    distribution[k] += r.n;
    total += r.n;
    sum += r.rating * r.n;
  }
  return { avg: total ? Math.round((sum / total) * 10) / 10 : 0, count: total, distribution };
}

// ─── Detail builders ──────────────────────────────────────────────────────────

/** Public PropertyDetail (ACTIVE room types + active rate plans only). */
export async function publicPropertyDetail(p: PropertyRow) {
  const [core, rtMap, summary, topReviewRows, expRows] = await Promise.all([
    propertyCore(p),
    loadRoomTypes([p.id], { publicOnly: true }),
    reviewSummary(p.id),
    db
      .select()
      .from(reviews)
      .where(and(eq(reviews.propertyId, p.id), eq(reviews.status, "PUBLISHED")))
      .orderBy(desc(reviews.createdAt))
      .limit(6),
    db
      .select()
      .from(experiences)
      .where(
        and(
          eq(experiences.isActive, true),
          p.cityId ? or(eq(experiences.propertyId, p.id), eq(experiences.cityId, p.cityId)) : eq(experiences.propertyId, p.id),
        ),
      )
      .orderBy(sql`(${experiences.propertyId} = ${p.id}) DESC NULLS LAST`, asc(experiences.sort))
      .limit(6),
  ]);
  const [topReviews, experienceCards] = await Promise.all([buildReviews(topReviewRows), buildExperienceCards(expRows)]);
  return {
    ...core,
    roomTypes: rtMap.get(p.id) ?? [],
    experiences: experienceCards,
    reviewSummary: summary,
    topReviews,
  };
}

/** PartnerPropertyDetail (all room types / rate plans, partner-only fields). */
export async function partnerPropertyDetail(p: PropertyRow) {
  const [core, rtMap] = await Promise.all([propertyCore(p), loadRoomTypes([p.id])]);
  return {
    ...core,
    partnerId: p.partnerId,
    status: p.status,
    reviewNotes: p.reviewNotes,
    contactPhone: p.contactPhone,
    contactEmail: p.contactEmail,
    cityId: p.cityId,
    areaId: p.areaId,
    isFeatured: p.isFeatured,
    isRecommended: p.isRecommended,
    curationRank: p.curationRank,
    roomTypes: rtMap.get(p.id) ?? [],
  };
}

export async function partnerPropertyDetailById(id: string) {
  const p = await db.query.properties.findFirst({ where: eq(properties.id, id) });
  if (!p) throw notFound("Property");
  return partnerPropertyDetail(p);
}

// ─── Rows for admin / partner lists ───────────────────────────────────────────

export async function buildAdminPropertyRows(rows: PropertyRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [rtCounts, partnerRows, cityRows] = await Promise.all([
    db
      .select({
        propertyId: roomTypes.propertyId,
        total: count(),
        pending: sql<number>`count(*) FILTER (WHERE ${roomTypes.status} = 'PENDING_APPROVAL')`.mapWith(Number),
      })
      .from(roomTypes)
      .where(inArray(roomTypes.propertyId, ids))
      .groupBy(roomTypes.propertyId),
    db
      .select({ id: partners.id, displayName: partners.displayName })
      .from(partners)
      .where(inArray(partners.id, uniq(rows.map((r) => r.partnerId)))),
    (() => {
      const cityIds = uniq(rows.map((r) => r.cityId));
      return cityIds.length
        ? db.select({ id: cities.id, name: cities.name }).from(cities).where(inArray(cities.id, cityIds))
        : Promise.resolve([] as { id: string; name: string }[]);
    })(),
  ]);
  const rtMap = new Map(rtCounts.map((r) => [r.propertyId, r]));
  const partnerMap = new Map(partnerRows.map((p) => [p.id, p.displayName]));
  const cityMap = new Map(cityRows.map((c) => [c.id, c.name]));
  return rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    type: p.type,
    status: p.status,
    partnerId: p.partnerId,
    partnerName: partnerMap.get(p.partnerId) ?? "",
    cityName: p.cityId ? (cityMap.get(p.cityId) ?? null) : null,
    coverImageUrl: p.coverImageUrl,
    startingPrice: p.startingPrice,
    roomTypeCount: rtMap.get(p.id)?.total ?? 0,
    pendingRoomTypes: rtMap.get(p.id)?.pending ?? 0,
    isFeatured: p.isFeatured,
    isRecommended: p.isRecommended,
    curationRank: p.curationRank,
    completedBookings: p.completedBookings,
    cancelledBookings: p.cancelledBookings,
    popularityScore: p.popularityScore,
    channelManaged: p.channelManaged,
    updatedAt: iso(p.updatedAt)!,
  }));
}
export type AdminPropertyRowDto = Awaited<ReturnType<typeof buildAdminPropertyRows>>[number];

export async function buildPartnerPropertyRows(rows: PropertyRow[]) {
  const adminRows = await buildAdminPropertyRows(rows);
  const notes = new Map(rows.map((r) => [r.id, r.reviewNotes]));
  return adminRows.map(({ partnerId: _p, partnerName: _n, isFeatured: _f, isRecommended: _r, ...rest }) => ({
    ...rest,
    reviewNotes: notes.get(rest.id) ?? null,
  }));
}
