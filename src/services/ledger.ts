// Partner ledger: every money movement between the platform and a partner.
// Balance = Σ amount (positive = we owe the partner). Settlements pick up unsettled rows.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import { bookings, ledgerEntries } from "../db/schema";

type BookingRow = typeof bookings.$inferSelect;
type Exec = typeof db | Tx;
export type LedgerRow = typeof ledgerEntries.$inferSelect;

export const BOOKING_ENTRY_TYPES = [
  "BOOKING_CREDIT",
  "COMMISSION_DEBIT",
  "COMMISSION_GST_DEBIT",
  "TCS_DEBIT",
  "TDS_DEBIT",
] as const;

function bookingEntryRows(b: BookingRow) {
  const partnerFundedDiscount =
    b.roomAmount + b.roomTax - b.commissionAmount - b.commissionTax - b.tcsAmount - b.tdsAmount - b.partnerPayout;
  return [
    { type: "BOOKING_CREDIT" as const, amount: b.roomAmount + b.roomTax, description: `Booking ${b.code}: room + GST` },
    { type: "COMMISSION_DEBIT" as const, amount: -b.commissionAmount, description: `Booking ${b.code}: commission` },
    { type: "COMMISSION_GST_DEBIT" as const, amount: -b.commissionTax, description: `Booking ${b.code}: GST on commission` },
    { type: "TCS_DEBIT" as const, amount: -b.tcsAmount, description: `Booking ${b.code}: TCS` },
    { type: "TDS_DEBIT" as const, amount: -b.tdsAmount, description: `Booking ${b.code}: TDS` },
    ...(partnerFundedDiscount
      ? [{ type: "ADJUSTMENT" as const, amount: -partnerFundedDiscount, description: `Booking ${b.code}: partner-funded discount` }]
      : []),
  ];
}

/** Posted once when a booking is confirmed. Σ = booking.partnerPayout. */
export async function postBookingEntries(tx: Tx, b: BookingRow, meta?: Record<string, unknown>) {
  const rows = bookingEntryRows(b).filter((r) => r.amount !== 0 || r.type === "BOOKING_CREDIT");
  await tx.insert(ledgerEntries).values(rows.map((r) => ({ ...r, partnerId: b.partnerId, bookingId: b.id, meta })));
}

/**
 * Booking modification: reverses the entries of the booking's previous economics (Σ = −old payout).
 * Followed by postBookingEntries(newBooking), the booking's ledger then sums to the new payout.
 */
export async function postBookingReversalEntries(tx: Tx, oldBooking: BookingRow, meta?: Record<string, unknown>) {
  const rows = bookingEntryRows(oldBooking)
    .filter((r) => r.amount !== 0)
    .map((r) => ({ ...r, amount: -r.amount, description: `${r.description} (reversed — booking modified)` }));
  if (rows.length)
    await tx
      .insert(ledgerEntries)
      .values(rows.map((r) => ({ ...r, partnerId: oldBooking.partnerId, bookingId: oldBooking.id, meta })));
}

/**
 * On cancellation the guest gets `refundAmount` back (fraction f of what they paid). The partner bears
 * f of the room value (REFUND_DEBIT) and we give back f of commission / GST / TCS / TDS (reversal rows),
 * so the partner nets (1 − f) × payout. A full refund nets the booking to zero.
 */
export async function postCancellationEntries(tx: Tx, b: BookingRow, refundAmount: number, policyFraction?: number) {
  if (b.totalAmount <= 0) return;
  // The partner's share follows the refund *policy* (e.g. 100% refundable → partner keeps nothing), even when
  // the guest actually paid less than the booking total (a price difference the platform waived).
  const f = Math.min(1, Math.max(0, policyFraction ?? refundAmount / b.totalAmount));
  if (f <= 0) return;
  const part = (n: number) => Math.round(n * f);
  const partnerFundedDiscount =
    b.roomAmount + b.roomTax - b.commissionAmount - b.commissionTax - b.tcsAmount - b.tdsAmount - b.partnerPayout;
  const rows = [
    { type: "REFUND_DEBIT" as const, amount: -part(b.roomAmount + b.roomTax - partnerFundedDiscount), description: `Booking ${b.code}: guest refund` },
    { type: "COMMISSION_DEBIT" as const, amount: part(b.commissionAmount), description: `Booking ${b.code}: commission reversal` },
    { type: "COMMISSION_GST_DEBIT" as const, amount: part(b.commissionTax), description: `Booking ${b.code}: GST on commission reversal` },
    { type: "TCS_DEBIT" as const, amount: part(b.tcsAmount), description: `Booking ${b.code}: TCS reversal` },
    { type: "TDS_DEBIT" as const, amount: part(b.tdsAmount), description: `Booking ${b.code}: TDS reversal` },
  ].filter((r) => r.amount !== 0);
  if (rows.length)
    await tx
      .insert(ledgerEntries)
      .values(rows.map((r) => ({ ...r, partnerId: b.partnerId, bookingId: b.id, meta: { refundAmount, fraction: f } })));
}

export async function partnerBalance(partnerId: string, exec: Exec = db): Promise<number> {
  const [{ total }] = await exec
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.partnerId, partnerId));
  return Number(total);
}

export async function ledgerDto(rows: LedgerRow[], exec: Exec = db) {
  const ids = [...new Set(rows.map((r) => r.bookingId).filter(Boolean))] as string[];
  const codes = ids.length
    ? await exec.select({ id: bookings.id, code: bookings.code }).from(bookings).where(inArray(bookings.id, ids))
    : [];
  const codeOf = new Map(codes.map((c) => [c.id, c.code]));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    description: r.description,
    bookingCode: r.bookingId ? (codeOf.get(r.bookingId) ?? null) : null,
    settlementId: r.settlementId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function settlementLedgerSum(settlementId: string, exec: Exec = db) {
  const [{ total }] = await exec
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.settlementId, settlementId)));
  return Number(total);
}
