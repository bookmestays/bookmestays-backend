// Settlement engine (API_CONTRACT §8).
//
// run: per partner, every COMPLETED / NO_SHOW / CANCELLED(after payment) booking whose settlementDueDate ≤ today
//      and that has no settlement yet, plus all unsettled ledger rows of those bookings and unsettled
//      booking-less rows (manual adjustments, payout reversals) → one PENDING settlement. Bookings, ledger rows
//      and Route transfers are linked through settlementId. Amounts are derived from the ledger, so refunds /
//      reversals are already netted in.
// approve: Route transfers still on hold are released (transfers.edit on_hold=0). Whatever is still owed
//      (no Route, or adjustments not covered by transfers) is paid by a RazorpayX payout. A negative balance is
//      carried forward to the next cycle.
// Every amount paid out is recorded as a PAYOUT_DEBIT ledger row on the settlement, so
// Σ ledger(settlement) = what is still outstanding for it.
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db";
import { bookings, ledgerEntries, partners, paymentTransfers, payouts, settlements } from "../../db/schema";
import { conflict, notFound } from "../../lib/errors";
import { toDateStr, todayIST } from "../../lib/utils";
import { bookingSummaries } from "../bookings/dto";
import { ledgerDto, settlementLedgerSum } from "../ledger";
import { createPayout, ensureFundAccount, razorpayErrorMessage, releaseTransfer } from "../razorpay";

export { settlementDueDate } from "./due-date";

type SettlementRow = typeof settlements.$inferSelect;
const SETTLEABLE = ["COMPLETED", "NO_SHOW", "CANCELLED"] as const;
const istDate = (d: Date) => toDateStr(new Date(d.getTime() + 5.5 * 3600_000));

// ─── Generate ────────────────────────────────────────────────────────────────

const dueBookingsWhere = (today: string, partnerId?: string) =>
  and(
    partnerId ? eq(bookings.partnerId, partnerId) : undefined,
    inArray(bookings.status, [...SETTLEABLE]),
    isNotNull(bookings.confirmedAt),
    isNull(bookings.settlementId),
    lte(bookings.settlementDueDate, today),
  );

export async function generateSettlements(today = todayIST()): Promise<number> {
  const fromBookings = await db.selectDistinct({ partnerId: bookings.partnerId }).from(bookings).where(dueBookingsWhere(today));
  const fromLedger = await db
    .selectDistinct({ partnerId: ledgerEntries.partnerId })
    .from(ledgerEntries)
    .where(and(isNull(ledgerEntries.settlementId), isNull(ledgerEntries.bookingId)));
  const partnerIds = [...new Set([...fromBookings, ...fromLedger].map((r) => r.partnerId))];
  let created = 0;
  for (const partnerId of partnerIds) {
    try {
      if (await settlePartner(partnerId, today)) created++;
    } catch (err) {
      console.error(`settlement generation failed for partner ${partnerId}`, err);
    }
  }
  return created;
}

async function settlePartner(partnerId: string, today: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serialise runs per partner (cron + "run now" + several API instances)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settle:${partnerId}`}))`);
    const bks = await tx.select().from(bookings).where(dueBookingsWhere(today, partnerId)).for("update");
    const bookingIds = bks.map((b) => b.id);
    const entries = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.partnerId, partnerId),
          isNull(ledgerEntries.settlementId),
          or(isNull(ledgerEntries.bookingId), bookingIds.length ? inArray(ledgerEntries.bookingId, bookingIds) : undefined),
        ),
      );
    const net = entries.reduce((s, e) => s + e.amount, 0);
    if (!bks.length && (!entries.length || net <= 0)) return false; // negative adjustments wait for bookings

    const sum = (...types: string[]) => entries.filter((e) => types.includes(e.type)).reduce((s, e) => s + e.amount, 0);
    const dates = [...bks.map((b) => b.checkOut), ...entries.filter((e) => !e.bookingId).map((e) => istDate(e.createdAt))].sort();
    const [s] = await tx
      .insert(settlements)
      .values({
        partnerId,
        periodStart: dates[0] ?? today,
        periodEnd: dates.at(-1) ?? today,
        scheduledFor: today,
        bookingsCount: bks.length,
        grossAmount: sum("BOOKING_CREDIT"),
        commissionAmount: -sum("COMMISSION_DEBIT"),
        commissionTax: -sum("COMMISSION_GST_DEBIT"),
        tcsAmount: -sum("TCS_DEBIT"),
        tdsAmount: -sum("TDS_DEBIT"),
        refundAdjustments: sum("REFUND_DEBIT", "CANCELLATION_FEE_CREDIT"),
        otherAdjustments: sum("ADJUSTMENT", "PAYOUT_DEBIT"),
        netPayable: net,
        status: "PENDING",
      })
      .returning();
    if (bookingIds.length) {
      await tx.update(bookings).set({ settlementId: s.id }).where(inArray(bookings.id, bookingIds));
      await tx.update(paymentTransfers).set({ settlementId: s.id }).where(inArray(paymentTransfers.bookingId, bookingIds));
    }
    if (entries.length)
      await tx.update(ledgerEntries).set({ settlementId: s.id }).where(inArray(ledgerEntries.id, entries.map((e) => e.id)));
    return true;
  });
}

// ─── Approve / pay ───────────────────────────────────────────────────────────

async function lockForAction(id: string, allowed: SettlementRow["status"][], action: string) {
  const [s] = await db.select().from(settlements).where(eq(settlements.id, id));
  if (!s) throw notFound("Settlement");
  if (!allowed.includes(s.status)) throw conflict(`Cannot ${action} a settlement that is ${s.status}`);
  return s;
}

export async function approveSettlement(id: string, actorUserId: string) {
  const s = await lockForAction(id, ["PENDING", "ON_HOLD", "FAILED"], "approve");
  // Compare-and-set so two admins can't approve (and pay) the same settlement twice
  const [claimed] = await db
    .update(settlements)
    .set({ status: "APPROVED", approvedBy: actorUserId, approvedAt: new Date(), failureReason: null })
    .where(and(eq(settlements.id, id), eq(settlements.status, s.status)))
    .returning();
  if (!claimed) throw conflict("Settlement was updated by someone else, please refresh");
  await paySettlement(claimed);
  const [out] = await db.select().from(settlements).where(eq(settlements.id, id));
  return out;
}

async function fail(id: string, reason: string) {
  await db.update(settlements).set({ status: "FAILED", failureReason: reason.slice(0, 1000) }).where(eq(settlements.id, id));
}

async function paySettlement(s: SettlementRow) {
  const [partner] = await db.select().from(partners).where(eq(partners.id, s.partnerId));
  let outstanding = await settlementLedgerSum(s.id);
  const methods: string[] = [];
  let utr: string | null = null;

  // 1) Route: release the partner's share that has been sitting on hold since payment
  if (env.razorpay.routeEnabled && partner.razorpayLinkedAccountId && outstanding > 0) {
    const transfers = await db
      .select()
      .from(paymentTransfers)
      .where(
        and(
          eq(paymentTransfers.settlementId, s.id),
          inArray(paymentTransfers.status, ["CREATED", "ON_HOLD"]),
          isNotNull(paymentTransfers.providerTransferId),
        ),
      );
    let released = 0;
    const errors: string[] = [];
    for (const t of transfers) {
      const remaining = t.amount - t.amountReversed;
      if (remaining <= 0) continue;
      try {
        const raw = await releaseTransfer(t.providerTransferId!);
        await db
          .update(paymentTransfers)
          .set({ status: "RELEASED", raw: raw as object })
          .where(eq(paymentTransfers.id, t.id));
        released += remaining;
      } catch (err) {
        errors.push(`${t.providerTransferId}: ${razorpayErrorMessage(err)}`);
      }
    }
    if (released > 0) {
      await db.insert(ledgerEntries).values({
        partnerId: s.partnerId,
        settlementId: s.id,
        type: "PAYOUT_DEBIT",
        amount: -released,
        description: `Settlement: Route transfers released (${transfers.length})`,
        meta: { method: "ROUTE_RELEASE" },
      });
      outstanding -= released;
      methods.push("ROUTE_RELEASE");
    }
    if (errors.length) return fail(s.id, `Route transfer release failed — ${errors.join("; ")}`);
  }

  // 2) RazorpayX payout for whatever is still owed
  if (outstanding > 0) {
    try {
      const fundAccountId = await ensureFundAccount(s.partnerId);
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(payouts)
        .where(eq(payouts.settlementId, s.id));
      const res = await createPayout({
        fundAccountId,
        amount: outstanding,
        referenceId: s.id.replace(/-/g, "").slice(0, 32),
        narration: "BookMeStays settlement",
        idempotencyKey: `stl_${s.id}_${n + 1}`,
      });
      const [payout] = await db
        .insert(payouts)
        .values({
          settlementId: s.id,
          partnerId: s.partnerId,
          providerPayoutId: res.id,
          amount: outstanding,
          mode: res.mode,
          status: res.status,
          utr: res.utr,
          raw: res.raw as object,
        })
        .returning();
      await db.insert(ledgerEntries).values({
        partnerId: s.partnerId,
        settlementId: s.id,
        type: "PAYOUT_DEBIT",
        amount: -outstanding,
        description: `Settlement payout (${res.mode})`,
        meta: { method: "RAZORPAYX_PAYOUT", payoutId: payout.id },
      });
      methods.push("RAZORPAYX_PAYOUT");
      utr = res.utr;
      if (res.status !== "processed") {
        await db
          .update(settlements)
          .set({ status: "PROCESSING", method: methodLabel(methods) })
          .where(eq(settlements.id, s.id));
        return;
      }
    } catch (err) {
      return fail(s.id, `Payout failed — ${razorpayErrorMessage(err)}`);
    }
  } else if (outstanding < 0) {
    await carryForward(s, outstanding);
  }

  await db
    .update(settlements)
    .set({ status: "PAID", method: methodLabel(methods), utr, paidAt: new Date() })
    .where(eq(settlements.id, s.id));
}

const methodLabel = (m: string[]) => (m.length === 2 ? "ROUTE+PAYOUT" : (m[0] ?? "NIL"));

/** Closes a negative settlement and moves the amount the partner owes into the next cycle. */
async function carryForward(s: SettlementRow, outstanding: number) {
  await db.insert(ledgerEntries).values([
    {
      partnerId: s.partnerId,
      settlementId: s.id,
      type: "ADJUSTMENT",
      amount: -outstanding,
      description: "Negative balance carried forward to next settlement",
    },
    {
      partnerId: s.partnerId,
      type: "ADJUSTMENT",
      amount: outstanding,
      description: `Carried forward from settlement ${s.id.slice(0, 8)}`,
      meta: { fromSettlementId: s.id },
    },
  ]);
}

export async function markSettlementPaid(id: string, utr: string, actorUserId: string) {
  const s = await lockForAction(id, ["PENDING", "APPROVED", "ON_HOLD", "FAILED"], "mark as paid");
  const outstanding = await settlementLedgerSum(s.id);
  if (outstanding > 0)
    await db.insert(ledgerEntries).values({
      partnerId: s.partnerId,
      settlementId: s.id,
      type: "PAYOUT_DEBIT",
      amount: -outstanding,
      description: `Manual bank transfer (UTR ${utr})`,
      meta: { method: "MANUAL", utr },
    });
  else if (outstanding < 0) await carryForward(s, outstanding);
  const [out] = await db
    .update(settlements)
    .set({
      status: "PAID",
      method: "MANUAL",
      utr,
      paidAt: new Date(),
      approvedBy: s.approvedBy ?? actorUserId,
      approvedAt: s.approvedAt ?? new Date(),
      failureReason: null,
    })
    .where(eq(settlements.id, id))
    .returning();
  return out;
}

export async function holdSettlement(id: string, reason: string) {
  await lockForAction(id, ["PENDING", "APPROVED", "FAILED"], "hold");
  const [out] = await db
    .update(settlements)
    .set({ status: "ON_HOLD", failureReason: reason })
    .where(eq(settlements.id, id))
    .returning();
  return out;
}

// ─── Webhook: RazorpayX payout status ────────────────────────────────────────

export async function handlePayoutEvent(entity: {
  id: string;
  status?: string;
  utr?: string | null;
  failure_reason?: string | null;
  status_details?: { description?: string } | null;
}) {
  const [payout] = await db.select().from(payouts).where(eq(payouts.providerPayoutId, entity.id));
  if (!payout) return;
  const status = entity.status ?? payout.status;
  const wasFailed = ["failed", "reversed", "rejected", "cancelled"].includes(payout.status);
  await db
    .update(payouts)
    .set({
      status,
      utr: entity.utr ?? payout.utr,
      failureReason: entity.failure_reason ?? entity.status_details?.description ?? payout.failureReason,
      raw: entity as object,
    })
    .where(eq(payouts.id, payout.id));
  if (!payout.settlementId) return;
  if (status === "processed") {
    await db
      .update(settlements)
      .set({ status: "PAID", utr: entity.utr ?? null, paidAt: new Date() })
      .where(and(eq(settlements.id, payout.settlementId), inArray(settlements.status, ["PROCESSING", "APPROVED"])));
  } else if (["failed", "reversed", "rejected", "cancelled"].includes(status) && !wasFailed) {
    // Undo the payout debit so the settlement shows the amount as owed again (admin can re-approve)
    await db.insert(ledgerEntries).values({
      partnerId: payout.partnerId,
      settlementId: payout.settlementId,
      type: "PAYOUT_DEBIT",
      amount: payout.amount,
      description: `Payout ${status} — amount re-credited`,
      meta: { payoutId: payout.id },
    });
    await fail(payout.settlementId, `Payout ${status}: ${entity.failure_reason ?? entity.status_details?.description ?? "no reason given"}`);
  }
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

export async function settlementDtos(rows: SettlementRow[]) {
  const ids = [...new Set(rows.map((r) => r.partnerId))];
  const names = ids.length
    ? await db.select({ id: partners.id, name: partners.displayName }).from(partners).where(inArray(partners.id, ids))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((s) => ({
    id: s.id,
    partnerId: s.partnerId,
    partnerName: nameOf.get(s.partnerId) ?? "",
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    scheduledFor: s.scheduledFor,
    bookingsCount: s.bookingsCount,
    grossAmount: s.grossAmount,
    commissionAmount: s.commissionAmount,
    commissionTax: s.commissionTax,
    tcsAmount: s.tcsAmount,
    tdsAmount: s.tdsAmount,
    refundAdjustments: s.refundAdjustments,
    otherAdjustments: s.otherAdjustments,
    netPayable: s.netPayable,
    status: s.status,
    method: s.method,
    utr: s.utr,
    paidAt: s.paidAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  }));
}

export async function settlementDetail(s: SettlementRow, opts: { includeInternal?: boolean } = {}) {
  const [dto] = await settlementDtos([s]);
  const bks = await db.select().from(bookings).where(eq(bookings.settlementId, s.id)).orderBy(bookings.checkOut);
  const ledger = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.settlementId, s.id))
    .orderBy(ledgerEntries.createdAt);
  const extra = opts.includeInternal
    ? {
        failureReason: s.failureReason,
        payouts: await db.select().from(payouts).where(eq(payouts.settlementId, s.id)).orderBy(desc(payouts.createdAt)),
        transfers: await db.select().from(paymentTransfers).where(eq(paymentTransfers.settlementId, s.id)),
      }
    : {};
  return { ...dto, bookings: await bookingSummaries(bks), ledger: await ledgerDto(ledger), ...extra };
}
