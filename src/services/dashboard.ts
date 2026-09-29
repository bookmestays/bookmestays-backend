// AdminDashboard / PartnerDashboard aggregates.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  bookings,
  channelConnections,
  channelSyncLogs,
  cities,
  inventory,
  ledgerEntries,
  partners,
  properties,
  reviews,
  roomTypes,
  settlements,
} from "../db/schema";
import { addDays, todayIST } from "../lib/utils";
import { bookingSummaries } from "./bookings/dto";
import { PROVIDERS } from "./channel/providers";

const PAID = ["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW"] as const;
const confirmedDay = sql<string>`to_char(${bookings.confirmedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
const num = (v: unknown) => Number(v ?? 0);

function fillDays<T extends { date: string }>(start: string, days: number, rows: T[], empty: (date: string) => T): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(start, i);
    return byDate.get(d) ?? empty(d);
  });
}

export async function adminDashboard() {
  const today = todayIST();
  const monthStart = `${today.slice(0, 8)}01`;
  const start30 = addDays(today, -29);
  const paid = inArray(bookings.status, [...PAID]);

  const [totals] = await db
    .select({
      gmvToday: sql`coalesce(sum(${bookings.totalAmount}) filter (where ${confirmedDay} = ${today}), 0)`,
      gmvMonth: sql`coalesce(sum(${bookings.totalAmount}) filter (where ${confirmedDay} >= ${monthStart}), 0)`,
      commissionMonth: sql`coalesce(sum(${bookings.commissionAmount}) filter (where ${confirmedDay} >= ${monthStart}), 0)`,
      bookingsToday: sql`count(*) filter (where ${confirmedDay} = ${today})`,
      bookingsMonth: sql`count(*) filter (where ${confirmedDay} >= ${monthStart})`,
    })
    .from(bookings)
    .where(and(paid, gte(confirmedDay, start30 < monthStart ? start30 : monthStart)));

  const [[pending], [live], [pendingProps], [pendingRts], [kyc], [pendingReviews], daily, recent, connCounts, errCounts] =
    await Promise.all([
      db
        .select({ v: sql`coalesce(sum(${settlements.netPayable}), 0)` })
        .from(settlements)
        .where(inArray(settlements.status, ["PENDING", "APPROVED", "PROCESSING", "ON_HOLD", "FAILED"])),
      db
        .select({
          partners: sql`count(distinct ${properties.partnerId})`,
          properties: sql`count(*)`,
        })
        .from(properties)
        .innerJoin(partners, eq(partners.id, properties.partnerId))
        .where(and(eq(properties.status, "LIVE"), eq(partners.status, "ACTIVE"))),
      db.select({ n: sql`count(*)` }).from(properties).where(eq(properties.status, "PENDING_REVIEW")),
      db.select({ n: sql`count(*)` }).from(roomTypes).where(eq(roomTypes.status, "PENDING_APPROVAL")),
      db.select({ n: sql`count(*)` }).from(partners).where(eq(partners.kycStatus, "SUBMITTED")),
      db.select({ n: sql`count(*)` }).from(reviews).where(eq(reviews.status, "PENDING")),
      db
        .select({ date: confirmedDay, gmv: sql`coalesce(sum(${bookings.totalAmount}), 0)`, bookings: sql`count(*)` })
        .from(bookings)
        .where(and(paid, gte(confirmedDay, start30)))
        .groupBy(confirmedDay),
      db
        .select()
        .from(bookings)
        .where(notInArray(bookings.status, ["EXPIRED", "PENDING_PAYMENT"]))
        .orderBy(desc(bookings.createdAt))
        .limit(10),
      db
        .select({ provider: channelConnections.provider, n: sql`count(*)` })
        .from(channelConnections)
        .where(eq(channelConnections.status, "ACTIVE"))
        .groupBy(channelConnections.provider),
      db
        .select({ provider: channelSyncLogs.provider, n: sql`count(*)` })
        .from(channelSyncLogs)
        .where(and(eq(channelSyncLogs.status, "FAILED"), gt(channelSyncLogs.createdAt, new Date(Date.now() - 86_400_000))))
        .groupBy(channelSyncLogs.provider),
    ]);

  return {
    totals: {
      gmvToday: num(totals?.gmvToday),
      gmvMonth: num(totals?.gmvMonth),
      commissionMonth: num(totals?.commissionMonth),
      bookingsToday: num(totals?.bookingsToday),
      bookingsMonth: num(totals?.bookingsMonth),
      pendingPayouts: num(pending?.v),
      livePartners: num(live?.partners),
      liveProperties: num(live?.properties),
    },
    pendingApprovals: {
      properties: num(pendingProps?.n),
      roomTypes: num(pendingRts?.n),
      kyc: num(kyc?.n),
      reviews: num(pendingReviews?.n),
    },
    recentBookings: await bookingSummaries(recent),
    dailyGmv: fillDays(
      start30,
      30,
      daily.map((d) => ({ date: d.date, gmv: num(d.gmv), bookings: num(d.bookings) })),
      (date) => ({ date, gmv: 0, bookings: 0 }),
    ),
    channelHealth: PROVIDERS.map((provider) => ({
      provider,
      active: num(connCounts.find((c) => c.provider === provider)?.n),
      errors24h: num(errCounts.find((c) => c.provider === provider)?.n),
    })),
  };
}

export async function partnerDashboard(partnerId: string) {
  const today = todayIST();
  const monthStart = `${today.slice(0, 8)}01`;
  const start30 = addDays(today, -29);
  const mine = eq(bookings.partnerId, partnerId);
  const paid = inArray(bookings.status, [...PAID]);

  const [arrivals, departures, [counts], [month], daily, props, nextStl, unsettled] = await Promise.all([
    db
      .select()
      .from(bookings)
      .where(and(mine, eq(bookings.checkIn, today), inArray(bookings.status, ["CONFIRMED", "CHECKED_IN"])))
      .orderBy(asc(bookings.createdAt)),
    db
      .select()
      .from(bookings)
      .where(and(mine, eq(bookings.checkOut, today), inArray(bookings.status, ["CONFIRMED", "CHECKED_IN", "COMPLETED"])))
      .orderBy(asc(bookings.createdAt)),
    db
      .select({
        inHouse: sql`count(*) filter (where ${bookings.status} = 'CHECKED_IN')`,
        upcoming: sql`count(*) filter (where ${bookings.status} = 'CONFIRMED' and ${bookings.checkIn} >= ${today})`,
      })
      .from(bookings)
      .where(mine),
    db
      .select({ revenue: sql`coalesce(sum(${bookings.partnerPayout}), 0)`, n: sql`count(*)` })
      .from(bookings)
      .where(and(mine, paid, gte(confirmedDay, monthStart))),
    db
      .select({ date: confirmedDay, revenue: sql`coalesce(sum(${bookings.partnerPayout}), 0)`, bookings: sql`count(*)` })
      .from(bookings)
      .where(and(mine, paid, gte(confirmedDay, start30)))
      .groupBy(confirmedDay),
    db
      .select({ p: properties, cityName: cities.name })
      .from(properties)
      .leftJoin(cities, eq(cities.id, properties.cityId))
      .where(eq(properties.partnerId, partnerId))
      .orderBy(asc(properties.name)),
    db
      .select()
      .from(settlements)
      .where(and(eq(settlements.partnerId, partnerId), inArray(settlements.status, ["PENDING", "APPROVED", "PROCESSING"])))
      .orderBy(asc(settlements.scheduledFor))
      .limit(1),
    db
      .select({
        amount: sql`coalesce(sum(${ledgerEntries.amount}), 0)`,
      })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.partnerId, partnerId), isNull(ledgerEntries.settlementId))),
  ]);

  // Room types of this partner (for listing counts + occupancy)
  const propIds = props.map((r) => r.p.id);
  const rts = propIds.length ? await db.select().from(roomTypes).where(inArray(roomTypes.propertyId, propIds)) : [];
  const liveProps = new Set(props.filter((r) => r.p.status === "LIVE").map((r) => r.p.id));
  const sellable = rts.filter((rt) => rt.status === "ACTIVE" && liveProps.has(rt.propertyId));
  const end = addDays(today, 30);
  const inv = sellable.length
    ? await db
        .select()
        .from(inventory)
        .where(and(inArray(inventory.roomTypeId, sellable.map((r) => r.id)), gte(inventory.date, today), lt(inventory.date, end)))
    : [];
  let capacity = 0;
  let sold = 0;
  for (const rt of sellable) {
    const rows = inv.filter((r) => r.roomTypeId === rt.id);
    capacity += rt.totalRooms * (30 - rows.length) + rows.reduce((s, r) => s + Math.max(0, r.total - r.blocked), 0);
    sold += rows.reduce((s, r) => s + r.sold, 0);
  }

  let nextSettlement: { scheduledFor: string; estimatedAmount: number } | null = null;
  if (nextStl[0]) nextSettlement = { scheduledFor: nextStl[0].scheduledFor, estimatedAmount: nextStl[0].netPayable };
  else {
    const [due] = await db
      .select({ d: sql<string | null>`min(${bookings.settlementDueDate})` })
      .from(bookings)
      .where(and(mine, isNull(bookings.settlementId), inArray(bookings.status, [...PAID])));
    if (due?.d) nextSettlement = { scheduledFor: due.d, estimatedAmount: num(unsettled[0]?.amount) };
  }

  return {
    arrivalsToday: await bookingSummaries(arrivals),
    departuresToday: await bookingSummaries(departures),
    inHouse: num(counts?.inHouse),
    upcomingCount: num(counts?.upcoming),
    revenueMonth: num(month?.revenue),
    bookingsMonth: num(month?.n),
    occupancyNext30: capacity > 0 ? Math.min(1, Math.round((sold / capacity) * 1000) / 1000) : 0,
    nextSettlement,
    properties: props.map(({ p, cityName }) => {
      const own = rts.filter((rt) => rt.propertyId === p.id);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        type: p.type,
        status: p.status,
        cityName: cityName ?? null,
        coverImageUrl: p.coverImageUrl,
        startingPrice: p.startingPrice,
        roomTypeCount: own.length,
        pendingRoomTypes: own.filter((rt) => rt.status === "PENDING_APPROVAL").length,
        channelManaged: p.channelManaged,
        updatedAt: p.updatedAt.toISOString(),
        reviewNotes: p.reviewNotes,
      };
    }),
    dailyRevenue: fillDays(
      start30,
      30,
      daily.map((d) => ({ date: d.date, revenue: num(d.revenue), bookings: num(d.bookings) })),
      (date) => ({ date, revenue: 0, bookings: 0 }),
    ),
  };
}
