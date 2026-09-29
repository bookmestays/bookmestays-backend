// Booking → API DTO mappers (BookingSummary / BookingDetail in frontend src/lib/types.ts).
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { bookingRooms, bookings, cities, properties, reviews } from "../../db/schema";

export type BookingRow = typeof bookings.$inferSelect;
export type Audience = "guest" | "partner" | "admin";

async function propertyInfo(ids: string[]) {
  if (!ids.length) return new Map<string, Awaited<ReturnType<typeof loadProps>>[number]>();
  const rows = await loadProps(ids);
  return new Map(rows.map((r) => [r.id, r]));
}
const loadProps = (ids: string[]) =>
  db
    .select({
      id: properties.id,
      name: properties.name,
      slug: properties.slug,
      cityName: cities.name,
      coverImageUrl: properties.coverImageUrl,
      address: properties.address,
      checkInTime: properties.checkInTime,
      checkOutTime: properties.checkOutTime,
      contactPhone: properties.contactPhone,
      lat: properties.lat,
      lng: properties.lng,
    })
    .from(properties)
    .leftJoin(cities, eq(cities.id, properties.cityId))
    .where(inArray(properties.id, ids));

async function roomsOf(bookingIds: string[]) {
  const map = new Map<string, (typeof bookingRooms.$inferSelect)[]>();
  if (!bookingIds.length) return map;
  const rows = await db.select().from(bookingRooms).where(inArray(bookingRooms.bookingId, bookingIds));
  for (const r of rows) {
    if (!map.has(r.bookingId)) map.set(r.bookingId, []);
    map.get(r.bookingId)!.push(r);
  }
  return map;
}

const roomsLabel = (rooms: { quantity: number; roomTypeName: string }[]) => {
  const byName = new Map<string, number>();
  for (const r of rooms) byName.set(r.roomTypeName, (byName.get(r.roomTypeName) ?? 0) + r.quantity);
  return [...byName].map(([name, q]) => `${q} × ${name}`).join(", ");
};

function summary(
  b: BookingRow,
  p: Awaited<ReturnType<typeof loadProps>>[number] | undefined,
  rooms: { quantity: number; roomTypeName: string }[],
) {
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    nights: b.nights,
    adults: b.adults,
    children: b.children,
    guestName: b.guestName,
    totalAmount: b.totalAmount,
    property: {
      id: b.propertyId,
      name: p?.name ?? "",
      slug: p?.slug ?? "",
      cityName: p?.cityName ?? null,
      coverImageUrl: p?.coverImageUrl ?? null,
    },
    roomsLabel: roomsLabel(rooms),
    createdAt: b.createdAt.toISOString(),
  };
}

export type BookingSummaryDto = ReturnType<typeof summary>;

export async function bookingSummaries(rows: BookingRow[]): Promise<BookingSummaryDto[]> {
  const [props, rooms] = await Promise.all([
    propertyInfo([...new Set(rows.map((b) => b.propertyId))]),
    roomsOf(rows.map((b) => b.id)),
  ]);
  return rows.map((b) => summary(b, props.get(b.propertyId), rooms.get(b.id) ?? []));
}

export async function bookingDetail(b: BookingRow, audience: Audience) {
  const [props, rooms] = await Promise.all([propertyInfo([b.propertyId]), roomsOf([b.id])]);
  const p = props.get(b.propertyId);
  const lines = rooms.get(b.id) ?? [];
  const base = summary(b, p, lines);
  const detail = {
    ...base,
    guestEmail: b.guestEmail,
    guestPhone: b.guestPhone,
    specialRequests: b.specialRequests,
    rooms: lines.map((r) => ({
      roomTypeName: r.roomTypeName,
      ratePlanName: r.ratePlanName,
      quantity: r.quantity,
      nightlyPrices: r.nightlyPrices,
      amount: r.amount,
    })),
    roomAmount: b.roomAmount,
    roomTax: b.roomTax,
    addonsAmount: b.addonsAmount,
    discountAmount: b.discountAmount,
    refundAmount: b.refundAmount,
    cancellationPolicy: b.cancellationPolicy ?? null,
    terms: b.termsSnapshot,
    holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
    confirmedAt: b.confirmedAt?.toISOString() ?? null,
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    cancelReason: b.cancelReason,
    property: {
      ...base.property,
      address: p?.address ?? null,
      checkInTime: p?.checkInTime ?? null,
      checkOutTime: p?.checkOutTime ?? null,
      contactPhone: p?.contactPhone ?? null,
      lat: p?.lat ?? null,
      lng: p?.lng ?? null,
    },
  };
  if (audience === "guest") {
    let canReview = false;
    if (b.status === "COMPLETED") {
      const existing = await db.query.reviews.findFirst({ where: eq(reviews.bookingId, b.id) });
      canReview = !existing;
    }
    return { ...detail, canReview };
  }
  return {
    ...detail,
    commissionAmount: b.commissionAmount,
    commissionTax: b.commissionTax,
    tcsAmount: b.tcsAmount,
    tdsAmount: b.tdsAmount,
    partnerPayout: b.partnerPayout,
    settlementDueDate: b.settlementDueDate,
  };
}
