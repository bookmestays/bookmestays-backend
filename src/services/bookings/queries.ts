// Booking list queries shared by admin and partner panels.
import { and, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { bookings, bookingStatus } from "../../db/schema";
import { pageParams, paginated } from "../../lib/utils";
import { bookingSummaries } from "./dto";

type Status = (typeof bookingStatus.enumValues)[number];
export const BOOKING_STATUSES = bookingStatus.enumValues;

export type BookingListQuery = {
  status?: string;
  partnerId?: string;
  propertyId?: string;
  from?: string; // check-in on/after
  to?: string; // check-in on/before
  q?: string;
  page?: string;
  limit?: string;
};

export async function listBookings(query: BookingListQuery, scope: { partnerId?: string } = {}) {
  const { page, limit, offset } = pageParams(query);
  const statuses = (query.status ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Status => (BOOKING_STATUSES as readonly string[]).includes(s));
  const conds: (SQL | undefined)[] = [
    scope.partnerId ? eq(bookings.partnerId, scope.partnerId) : undefined,
    query.partnerId && !scope.partnerId ? eq(bookings.partnerId, query.partnerId) : undefined,
    query.propertyId ? eq(bookings.propertyId, query.propertyId) : undefined,
    query.from ? gte(bookings.checkIn, query.from) : undefined,
    query.to ? lte(bookings.checkIn, query.to) : undefined,
    statuses.length
      ? inArray(bookings.status, statuses)
      : notInArray(bookings.status, scope.partnerId ? ["EXPIRED", "PENDING_PAYMENT"] : ["EXPIRED"]),
  ];
  const q = query.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    conds.push(
      or(
        ilike(bookings.code, like),
        ilike(bookings.guestName, like),
        ilike(bookings.guestEmail, like),
        ilike(bookings.guestPhone, like),
      ),
    );
  }
  const where = and(...conds);
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(bookings).where(where).orderBy(desc(bookings.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(where),
  ]);
  return paginated(await bookingSummaries(rows), n, page, limit);
}
