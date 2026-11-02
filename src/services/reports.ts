// Admin revenue & payout report: bookings, GMV, commission earned, and amount payable/paid to hotels,
// grouped by week or month over a date range. Based on confirmed (paid) bookings by confirmation date.
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, partners, settlements } from "../db/schema";
import { todayIST } from "../lib/utils";

const PAID = ["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW"] as const;
const OUTSTANDING = ["PENDING", "APPROVED", "PROCESSING", "ON_HOLD", "FAILED"] as const;
const num = (v: unknown) => Number(v ?? 0);

// Day/period expressions in IST.
const bookingDay = sql<string>`to_char(${bookings.confirmedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
const paidDay = sql<string>`to_char(${settlements.paidAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;

const metrics = {
  bookings: sql<number>`count(*)::int`,
  gmv: sql<number>`coalesce(sum(${bookings.totalAmount}), 0)::bigint`,
  roomRevenue: sql<number>`coalesce(sum(${bookings.roomAmount} + ${bookings.roomTax}), 0)::bigint`,
  commission: sql<number>`coalesce(sum(${bookings.commissionAmount}), 0)::bigint`,
  commissionTax: sql<number>`coalesce(sum(${bookings.commissionTax}), 0)::bigint`,
  tcs: sql<number>`coalesce(sum(${bookings.tcsAmount}), 0)::bigint`,
  tds: sql<number>`coalesce(sum(${bookings.tdsAmount}), 0)::bigint`,
  hotelPayout: sql<number>`coalesce(sum(${bookings.partnerPayout}), 0)::bigint`,
};

type RawMetrics = Record<keyof typeof metrics, unknown>;
const shape = (r: RawMetrics) => {
  const commission = num(r.commission);
  const commissionTax = num(r.commissionTax);
  return {
    bookings: num(r.bookings),
    gmv: num(r.gmv),
    roomRevenue: num(r.roomRevenue),
    commission,
    commissionTax,
    commissionTotal: commission + commissionTax, // our earning (commission + GST on it)
    taxesCollected: num(r.tcs) + num(r.tds),
    hotelPayout: num(r.hotelPayout),
  };
};

export type ReportParams = { from?: string; to?: string; groupBy?: "week" | "month" };

export async function adminReport(params: ReportParams) {
  const today = todayIST();
  const to = params.to ?? today;
  const from = params.from ?? `${today.slice(0, 8)}01`; // default: start of this month
  const groupBy = params.groupBy === "week" ? "week" : "month";

  const inRange = and(
    inArray(bookings.status, [...PAID]),
    isNotNull(bookings.confirmedAt),
    gte(bookingDay, from),
    lte(bookingDay, to),
  );

  const periodExpr =
    groupBy === "week"
      ? sql<string>`to_char(date_trunc('week', ${bookings.confirmedAt} at time zone 'Asia/Kolkata'), 'YYYY-MM-DD')`
      : sql<string>`to_char(${bookings.confirmedAt} at time zone 'Asia/Kolkata', 'YYYY-MM')`;

  const [summaryRows, bucketRows, partnerRows, [paid], [outstanding]] = await Promise.all([
    db.select(metrics).from(bookings).where(inRange),
    db.select({ period: periodExpr, ...metrics }).from(bookings).where(inRange).groupBy(periodExpr).orderBy(periodExpr),
    db.select({ partnerId: bookings.partnerId, ...metrics }).from(bookings).where(inRange).groupBy(bookings.partnerId),
    // Actually transferred to hotels in the range (settlements marked paid)
    db
      .select({ v: sql<number>`coalesce(sum(${settlements.netPayable}), 0)::bigint` })
      .from(settlements)
      .where(and(eq(settlements.status, "PAID"), gte(paidDay, from), lte(paidDay, to))),
    // Currently owed to hotels (not yet paid) — a running figure, not range-bound
    db
      .select({ v: sql<number>`coalesce(sum(${settlements.netPayable}), 0)::bigint` })
      .from(settlements)
      .where(inArray(settlements.status, [...OUTSTANDING])),
  ]);

  const names = partnerRows.length
    ? await db
        .select({ id: partners.id, name: partners.displayName })
        .from(partners)
        .where(inArray(partners.id, partnerRows.map((p) => p.partnerId)))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));

  const perPartner = partnerRows
    .map((r) => ({ partnerId: r.partnerId, partnerName: nameOf.get(r.partnerId) ?? "—", ...shape(r) }))
    .sort((a, b) => b.hotelPayout - a.hotelPayout);

  return {
    range: { from, to, groupBy },
    summary: shape(summaryRows[0]),
    buckets: bucketRows.map((r) => ({ period: r.period, ...shape(r) })),
    perPartner,
    payouts: {
      paidToHotels: num(paid?.v),
      outstandingToHotels: num(outstanding?.v),
    },
  };
}
