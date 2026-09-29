// Booking lifecycle: create (inventory hold) → confirm (payment) → check-in/out/no-show/complete,
// cancel (policy refund), expire (hold timeout). All inventory changes happen inside transactions
// with row locks; payment confirmation is idempotent (guarded by the locked booking row's status).
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { db, type Tx } from "../../db";
import {
  bookingRooms,
  bookings,
  coupons,
  inventory,
  partners,
  payments,
  paymentTransfers,
  properties,
  refunds,
  roomTypes,
} from "../../db/schema";
import { AppError, conflict, notFound, unprocessable } from "../../lib/errors";
import { notifyLater, sendEmail } from "../../lib/notify";
import { addDays, bookingCode, nightsBetween, todayIST } from "../../lib/utils";
import { activeConnectionFor, queueReservationPush } from "../channel/outbound";
import { recalcPopularity, refreshPopularityFor } from "../catalog/popularity";
import { postBookingEntries, postCancellationEntries } from "../ledger";
import {
  buildQuote,
  hoursUntilCheckIn,
  NON_REFUNDABLE,
  refundPercentAt,
  validateStay,
  type QuoteInput,
} from "../pricing";
import {
  createOrder,
  ensureCaptured,
  fetchPaymentTransfers,
  isMockPayments,
  mockId,
  paymentsKeyId,
  razorpayErrorMessage,
  refundPayment,
  type RouteTransfer,
} from "../razorpay";
import { getBookingSettings } from "../settings";
import { settlementDueDate } from "../settlements/due-date";
import type { BookingRow } from "./dto";
import { cancelPendingModifications, confirmModificationPayment, modificationForPayment } from "./modify";

type PaymentRow = typeof payments.$inferSelect;
const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const PAID_STATUSES = ["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW"] as const;

// ─── Inventory helpers ───────────────────────────────────────────────────────

export async function roomQuantities(exec: typeof db | Tx, bookingId: string) {
  const rows = await exec
    .select({ roomTypeId: bookingRooms.roomTypeId, quantity: bookingRooms.quantity })
    .from(bookingRooms)
    .where(eq(bookingRooms.bookingId, bookingId));
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.roomTypeId, (map.get(r.roomTypeId) ?? 0) + r.quantity);
  return [...map].sort(([a], [b]) => a.localeCompare(b)); // stable order → no lock-order deadlocks
}

/** Ensures inventory rows exist (defaults) for the stay, then locks them FOR UPDATE. */
export async function lockInventory(tx: Tx, roomTypeIds: string[], checkIn: string, checkOut: string) {
  if (!roomTypeIds.length) return [];
  const rts = await tx
    .select({ id: roomTypes.id, totalRooms: roomTypes.totalRooms })
    .from(roomTypes)
    .where(inArray(roomTypes.id, roomTypeIds));
  const nights = nightsBetween(checkIn, checkOut);
  if (rts.length && nights.length)
    await tx
      .insert(inventory)
      .values(rts.flatMap((rt) => nights.map((date) => ({ roomTypeId: rt.id, date, total: rt.totalRooms, updatedBy: "SYSTEM" }))))
      .onConflictDoNothing();
  return tx
    .select()
    .from(inventory)
    .where(and(inArray(inventory.roomTypeId, roomTypeIds), gte(inventory.date, checkIn), lt(inventory.date, checkOut)))
    .orderBy(asc(inventory.roomTypeId), asc(inventory.date))
    .for("update");
}

async function shiftInventory(
  tx: Tx,
  b: Pick<BookingRow, "id" | "checkIn" | "checkOut">,
  delta: { held?: number; sold?: number },
  from?: string,
) {
  const start = from && from > b.checkIn ? from : b.checkIn;
  if (start >= b.checkOut) return;
  for (const [roomTypeId, qty] of await roomQuantities(tx, b.id)) {
    await tx
      .update(inventory)
      .set({
        held: sql`greatest(0, ${inventory.held} + ${(delta.held ?? 0) * qty})`,
        sold: sql`greatest(0, ${inventory.sold} + ${(delta.sold ?? 0) * qty})`,
        updatedAt: new Date(),
      })
      .where(and(eq(inventory.roomTypeId, roomTypeId), gte(inventory.date, start), lt(inventory.date, b.checkOut)));
  }
}

// ─── Payment order DTO ───────────────────────────────────────────────────────

export function paymentOrderDto(b: BookingRow, p: PaymentRow) {
  return {
    provider: "RAZORPAY" as const,
    keyId: paymentsKeyId(),
    orderId: p.providerOrderId!,
    amount: p.amount,
    currency: "INR" as const,
    holdExpiresAt: (b.holdExpiresAt ?? new Date()).toISOString(),
    prefill: { name: b.guestName, email: b.guestEmail, contact: b.guestPhone },
  };
}

/** Unix timestamp for the end (23:59:59 IST) of a date. */
const endOfDayIstUnix = (date: string) => Math.floor(new Date(`${date}T23:59:59+05:30`).getTime() / 1000);

async function createPaymentForBooking(b: BookingRow) {
  const [partner] = await db.select().from(partners).where(eq(partners.id, b.partnerId));
  const due = settlementDueDate(partner, b.checkOut);
  const transfer: RouteTransfer | null =
    env.razorpay.routeEnabled && partner.razorpayLinkedAccountId && b.partnerPayout > 0
      ? {
          account: partner.razorpayLinkedAccountId,
          amount: Math.min(b.partnerPayout, b.totalAmount),
          onHoldUntil: endOfDayIstUnix(due),
          notes: { bookingCode: b.code, partnerId: partner.id },
        }
      : null;
  const order = await createOrder({
    amount: b.totalAmount,
    receipt: b.code,
    notes: { bookingCode: b.code, bookingId: b.id },
    transfer,
  });
  const [payment] = await db
    .insert(payments)
    .values({
      bookingId: b.id,
      providerOrderId: order.id,
      amount: b.totalAmount,
      status: "CREATED",
      raw: { order: order.raw, routeTransfer: transfer, settlementDueDate: due },
    })
    .returning();
  return payment;
}

// ─── Create ──────────────────────────────────────────────────────────────────

export type CreateBookingInput = QuoteInput & {
  guest: { name: string; email: string; phone: string };
  specialRequests?: string;
};

export async function createBooking(userId: string, input: CreateBookingInput) {
  await validateStay(input.checkIn, input.checkOut);
  const settings = await getBookingSettings();
  const requestedRt = [...new Set(input.rooms.map((r) => r.roomTypeId))];
  const ownRt = requestedRt.length
    ? await db
        .select({ id: roomTypes.id })
        .from(roomTypes)
        .where(and(inArray(roomTypes.id, requestedRt), eq(roomTypes.propertyId, input.propertyId)))
    : [];
  if (ownRt.length !== requestedRt.length) throw unprocessable("One of the selected rooms is no longer available");

  const booking = await db.transaction(async (tx) => {
    await lockInventory(tx, requestedRt, input.checkIn, input.checkOut);
    const q = await buildQuote(tx, input, { userId });
    if (q.totalAmount < 100) throw unprocessable("Booking amount is too low");

    for (const [roomTypeId, qty] of Object.entries(
      input.rooms.reduce<Record<string, number>>((m, r) => ((m[r.roomTypeId] = (m[r.roomTypeId] ?? 0) + r.quantity), m), {}),
    ))
      await tx
        .update(inventory)
        .set({ held: sql`${inventory.held} + ${qty}`, updatedAt: new Date() })
        .where(
          and(eq(inventory.roomTypeId, roomTypeId), gte(inventory.date, input.checkIn), lt(inventory.date, input.checkOut)),
        );

    const [b] = await tx
      .insert(bookings)
      .values({
        code: bookingCode(),
        userId,
        propertyId: q.ctx.property.id,
        partnerId: q.ctx.partner.id,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights: q.ctx.nights.length,
        adults: input.adults,
        children: input.children,
        guestName: input.guest.name.trim(),
        guestEmail: input.guest.email.trim().toLowerCase(),
        guestPhone: input.guest.phone.trim(),
        specialRequests: input.specialRequests?.trim() || null,
        status: "PENDING_PAYMENT",
        holdExpiresAt: new Date(Date.now() + settings.holdMinutes * 60_000),
        roomAmount: q.roomAmount,
        roomTax: q.roomTax,
        addonsAmount: 0,
        discountAmount: q.discountAmount,
        totalAmount: q.totalAmount,
        commissionAmount: q.commissionAmount,
        commissionTax: q.commissionTax,
        tcsAmount: q.tcsAmount,
        tdsAmount: q.tdsAmount,
        partnerPayout: q.partnerPayout,
        couponId: q.coupon?.id ?? null,
        cancellationPolicy: q.cancellationPolicy,
        termsSnapshot: q.terms,
        source: "WEB",
      })
      .returning();
    await tx.insert(bookingRooms).values(
      q.lines.map((l) => ({
        bookingId: b.id,
        roomTypeId: l.roomType.id,
        ratePlanId: l.ratePlan.id,
        roomTypeName: l.roomType.name,
        ratePlanName: l.ratePlan.name,
        quantity: l.quantity,
        adults: l.adults,
        children: l.children,
        nightlyPrices: l.nightly,
        amount: l.amount,
        commissionType: l.commission.type,
        commissionValue: l.commission.value,
        commissionAmount: l.commissionAmount,
      })),
    );
    return b;
  });

  try {
    const payment = await createPaymentForBooking(booking);
    return { booking, payment };
  } catch (err) {
    // Could not open a payment order → give the rooms back straight away
    await db.transaction(async (tx) => {
      await shiftInventory(tx, booking, { held: -1 });
      await tx.update(bookings).set({ status: "EXPIRED", holdExpiresAt: null }).where(eq(bookings.id, booking.id));
    });
    throw err;
  }
}

export async function retryPayment(b: BookingRow) {
  if (b.status !== "PENDING_PAYMENT") throw conflict("This booking is no longer awaiting payment");
  if (!b.holdExpiresAt || b.holdExpiresAt < new Date())
    throw new AppError(410, "HOLD_EXPIRED", "Your room hold has expired. Please start a new booking.");
  const [existing] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, b.id), inArray(payments.status, ["CREATED", "FAILED", "AUTHORIZED"])))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  // Razorpay orders accept further attempts after a failed payment, so the open order is reused.
  const payment = existing?.providerOrderId ? existing : await createPaymentForBooking(b);
  return paymentOrderDto(b, payment);
}

// ─── Confirm (verify-payment / webhook) ──────────────────────────────────────

export type ConfirmOutcome = "CONFIRMED" | "ALREADY" | "REFUND_REQUIRED";

export async function confirmPayment(p: {
  orderId: string;
  paymentId: string;
  method?: string | null;
  raw?: unknown;
  verifyWithGateway?: boolean;
}): Promise<{ booking: BookingRow; outcome: ConfirmOutcome }> {
  const [pre] = await db.select().from(payments).where(eq(payments.providerOrderId, p.orderId));
  if (!pre) throw notFound("Payment");
  // A supplementary payment for a booking change is applied by the modification flow instead.
  if (await modificationForPayment(pre.id)) {
    const r = await confirmModificationPayment(p);
    return { booking: r.booking, outcome: r.outcome === "APPLIED" ? "CONFIRMED" : "ALREADY" };
  }
  let method = p.method ?? null;
  let raw = p.raw;
  if (p.verifyWithGateway && pre.status !== "CAPTURED") {
    const captured = await ensureCaptured(p.paymentId, pre.amount);
    method ??= captured.method;
    raw ??= captured.raw;
  }

  const result = await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, pre.id)).for("update");
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, payment.bookingId)).for("update");

    if (payment.status === "CREATED" || payment.status === "FAILED" || payment.status === "AUTHORIZED") {
      await tx
        .update(payments)
        .set({
          status: "CAPTURED",
          providerPaymentId: p.paymentId,
          method: method ?? payment.method,
          errorCode: null,
          errorDescription: null,
          raw: { ...((payment.raw as object) ?? {}), capture: raw ?? null },
        })
        .where(eq(payments.id, payment.id));
    }

    if ((PAID_STATUSES as readonly string[]).includes(b.status)) return { booking: b, outcome: "ALREADY" as const };

    if (b.status === "CANCELLED") {
      const [existingRefund] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.paymentId, payment.id));
      if (existingRefund) return { booking: b, outcome: "ALREADY" as const };
      const [u] = await tx
        .update(bookings)
        .set({ refundAmount: payment.amount })
        .where(eq(bookings.id, b.id))
        .returning();
      return { booking: u, outcome: "REFUND_REQUIRED" as const };
    }

    const rooms = await roomQuantities(tx, b.id);
    if (b.status === "PENDING_PAYMENT") {
      await shiftInventory(tx, b, { held: -1, sold: 1 });
    } else if (b.status === "EXPIRED") {
      // Hold ran out before the payment arrived — take the rooms again if they are still free
      const locked = await lockInventory(tx, rooms.map(([id]) => id), b.checkIn, b.checkOut);
      const fits = rooms.every(([rtId, qty]) =>
        locked.filter((r) => r.roomTypeId === rtId).every((r) => r.total - r.sold - r.held - r.blocked >= qty),
      );
      if (!fits) {
        const [u] = await tx
          .update(bookings)
          .set({
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelledBy: "SYSTEM",
            cancelReason: "Rooms were no longer available when the payment completed",
            refundAmount: payment.amount,
          })
          .where(eq(bookings.id, b.id))
          .returning();
        return { booking: u, outcome: "REFUND_REQUIRED" as const };
      }
      await shiftInventory(tx, b, { sold: 1 });
    }

    const [partner] = await tx.select().from(partners).where(eq(partners.id, b.partnerId));
    const conn = await activeConnectionFor(b.propertyId, tx);
    const [confirmed] = await tx
      .update(bookings)
      .set({
        status: "CONFIRMED",
        confirmedAt: new Date(),
        holdExpiresAt: null,
        settlementDueDate: settlementDueDate(partner, b.checkOut),
        channelSyncStatus: conn ? "PENDING" : null,
      })
      .where(eq(bookings.id, b.id))
      .returning();
    await postBookingEntries(tx, confirmed);
    if (confirmed.couponId)
      await tx
        .update(coupons)
        .set({ usedCount: sql`${coupons.usedCount} + 1` })
        .where(eq(coupons.id, confirmed.couponId));
    return { booking: confirmed, outcome: "CONFIRMED" as const };
  });

  if (result.outcome === "CONFIRMED") {
    await recordRouteTransfer(pre.id).catch((err) => console.error("route transfer record failed", err));
    notifyLater(sendConfirmationEmails(result.booking));
    notifyLater(queueReservationPush(result.booking.id, "NEW"));
  } else if (result.outcome === "REFUND_REQUIRED") {
    const [payment] = await db.select().from(payments).where(eq(payments.id, pre.id));
    await issueRefund(result.booking, payment, payment.amount, result.booking.cancelReason ?? "Booking cancelled", null);
    notifyLater(sendCancellationEmails(result.booking));
  }
  return result;
}

/** Stores the Route transfer created from the order (held until the settlement date). */
async function recordRouteTransfer(paymentRowId: string) {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentRowId));
  const route = (payment?.raw as { routeTransfer?: RouteTransfer | null; settlementDueDate?: string })?.routeTransfer;
  if (!payment || !route) return;
  const [b] = await db.select().from(bookings).where(eq(bookings.id, payment.bookingId));
  const onHoldUntil = (payment.raw as { settlementDueDate?: string }).settlementDueDate ?? b.settlementDueDate;
  const existing = await db.select().from(paymentTransfers).where(eq(paymentTransfers.paymentId, payment.id));
  if (existing.length) return;
  if (isMockPayments() || payment.providerPaymentId?.startsWith("pay_mock_")) {
    await db.insert(paymentTransfers).values({
      paymentId: payment.id,
      bookingId: b.id,
      partnerId: b.partnerId,
      providerTransferId: mockId("trf"),
      amount: route.amount,
      onHoldUntil,
      status: "ON_HOLD",
      raw: { mock: true },
    });
    return;
  }
  const items = await fetchPaymentTransfers(payment.providerPaymentId!);
  for (const t of items)
    await db
      .insert(paymentTransfers)
      .values({
        paymentId: payment.id,
        bookingId: b.id,
        partnerId: b.partnerId,
        providerTransferId: t.id,
        amount: t.amount,
        onHoldUntil,
        status: t.on_hold ? "ON_HOLD" : "CREATED",
        raw: t,
      })
      .onConflictDoNothing();
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

export async function issueRefund(
  b: BookingRow,
  payment: PaymentRow,
  amount: number,
  reason: string,
  initiatedBy: string | null,
) {
  amount = Math.min(amount, payment.amount);
  if (amount <= 0 || !payment.providerPaymentId) return null;
  const [refund] = await db
    .insert(refunds)
    .values({ bookingId: b.id, paymentId: payment.id, amount, status: "PENDING", reason, initiatedBy })
    .returning();
  return executeRefund(refund, payment, b.code);
}

/** Calls Razorpay for a PENDING refund row and records the outcome (PROCESSED/PENDING or FAILED). */
async function executeRefund(refund: typeof refunds.$inferSelect, payment: PaymentRow, bookingCode: string) {
  const transfers = await db.select().from(paymentTransfers).where(eq(paymentTransfers.paymentId, payment.id));
  try {
    const res = await refundPayment(payment.providerPaymentId!, refund.amount, {
      reverseAll: transfers.length > 0,
      notes: { bookingCode, reason: (refund.reason ?? "").slice(0, 200), refundId: refund.id },
    });
    const [updated] = await db
      .update(refunds)
      .set({ providerRefundId: res.id, status: res.status, raw: res.raw as object })
      .where(eq(refunds.id, refund.id))
      .returning();
    const [{ refunded }] = await db
      .select({ refunded: sql<number>`coalesce(sum(${refunds.amount}), 0)::bigint` })
      .from(refunds)
      .where(and(eq(refunds.paymentId, payment.id), sql`${refunds.status} <> 'FAILED'`));
    await db
      .update(payments)
      .set({ status: Number(refunded) >= payment.amount ? "REFUNDED" : "PARTIALLY_REFUNDED" })
      .where(eq(payments.id, payment.id));
    // reverse_all pulls back the linked-account share proportionally to the refund
    for (const t of transfers) {
      const reversed = Math.min(t.amount, t.amountReversed + Math.round((t.amount * refund.amount) / payment.amount));
      await db
        .update(paymentTransfers)
        .set({ amountReversed: reversed, status: reversed >= t.amount ? "REVERSED" : t.status })
        .where(eq(paymentTransfers.id, t.id));
    }
    return updated;
  } catch (err) {
    console.error("refund failed", err);
    const [failed] = await db
      .update(refunds)
      .set({ status: "FAILED", raw: { error: razorpayErrorMessage(err) } })
      .where(eq(refunds.id, refund.id))
      .returning();
    return failed;
  }
}

/**
 * Re-attempts a FAILED refund. The FAILED → PENDING flip is a compare-and-set,
 * so two admins clicking "retry" at once cannot refund twice.
 */
export async function retryRefund(refundId: string) {
  const [claimed] = await db
    .update(refunds)
    .set({ status: "PENDING" })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "FAILED")))
    .returning();
  if (!claimed) {
    const existing = await db.query.refunds.findFirst({ where: eq(refunds.id, refundId) });
    if (!existing) throw notFound("Refund");
    throw conflict(`Only failed refunds can be retried (this one is ${existing.status.toLowerCase()})`);
  }
  const payment = await db.query.payments.findFirst({ where: eq(payments.id, claimed.paymentId) });
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, claimed.bookingId) });
  if (!payment?.providerPaymentId || !booking) throw notFound("Payment");
  return executeRefund(claimed, payment, booking.code);
}

/** Amount still refundable on each captured payment of a booking (newest payment first). */
export async function refundablePayments(bookingId: string, exec: typeof db | Tx = db) {
  const rows = await exec
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), inArray(payments.status, ["CAPTURED", "PARTIALLY_REFUNDED"])))
    .orderBy(desc(payments.createdAt));
  if (!rows.length) return [];
  const refunded = await exec
    .select({ paymentId: refunds.paymentId, total: sql<number>`coalesce(sum(${refunds.amount}), 0)::bigint` })
    .from(refunds)
    .where(and(inArray(refunds.paymentId, rows.map((p) => p.id)), sql`${refunds.status} <> 'FAILED'`))
    .groupBy(refunds.paymentId);
  const byPayment = new Map(refunded.map((r) => [r.paymentId, Number(r.total)]));
  return rows
    .map((payment) => ({ payment, remaining: payment.amount - (byPayment.get(payment.id) ?? 0) }))
    .filter((r) => r.remaining > 0);
}

/** Refunds `amount` spread over the booking's captured payments (a modified booking can have several). */
export async function refundAcrossPayments(b: BookingRow, amount: number, reason: string, initiatedBy: string | null) {
  let left = amount;
  const results = [];
  for (const { payment, remaining } of await refundablePayments(b.id)) {
    if (left <= 0) break;
    const part = Math.min(left, remaining);
    const r = await issueRefund(b, payment, part, reason, initiatedBy);
    if (r) results.push(r);
    left -= part;
  }
  return results;
}

// ─── Cancellation ────────────────────────────────────────────────────────────

export async function cancellationPreview(b: BookingRow) {
  const policy = b.cancellationPolicy ?? NON_REFUNDABLE;
  if (b.status === "PENDING_PAYMENT")
    return { refundAmount: 0, cancellationFee: 0, policy, canCancel: true };
  if (b.status !== "CONFIRMED")
    return {
      refundAmount: 0,
      cancellationFee: 0,
      policy,
      canCancel: false,
      reason:
        b.status === "CANCELLED" ? "This booking is already cancelled" : "This booking can no longer be cancelled online",
    };
  const [p] = await db.select({ checkInTime: properties.checkInTime }).from(properties).where(eq(properties.id, b.propertyId));
  const hours = hoursUntilCheckIn(b.checkIn, p?.checkInTime ?? null);
  if (hours <= 0)
    return {
      refundAmount: 0,
      cancellationFee: b.totalAmount,
      policy,
      canCancel: false,
      reason: "Check-in time has passed. Please contact the property.",
    };
  const refundAmount = Math.round((b.totalAmount * refundPercentAt(policy, hours)) / 100);
  return { refundAmount, cancellationFee: b.totalAmount - refundAmount, policy, canCancel: true };
}

export async function cancelBooking(
  bookingId: string,
  opts: { by: "GUEST" | "ADMIN" | "PARTNER" | "SYSTEM"; reason?: string | null; refundOverride?: number; actorUserId?: string | null },
) {
  const allowed = opts.by === "GUEST" ? ["CONFIRMED", "PENDING_PAYMENT"] : ["CONFIRMED", "CHECKED_IN", "PENDING_PAYMENT"];
  let refundTarget = 0;
  const pre = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!pre) throw notFound("Booking");
  if (opts.by === "GUEST") {
    const preview = await cancellationPreview(pre);
    if (!preview.canCancel) throw conflict(preview.reason ?? "This booking cannot be cancelled");
    refundTarget = preview.refundAmount;
  }

  await cancelPendingModifications(bookingId, "Booking cancelled");
  const { booking, wasPaid } = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!allowed.includes(b.status)) throw conflict(`A ${b.status.toLowerCase().replace("_", " ")} booking cannot be cancelled`);
    const wasPaid = b.status !== "PENDING_PAYMENT";
    let refundAmount = 0;
    let policyFraction = 0;
    if (wasPaid) {
      if (opts.refundOverride != null) refundAmount = opts.refundOverride;
      else if (opts.by === "GUEST") refundAmount = refundTarget;
      else refundAmount = (await cancellationPreview(b)).refundAmount;
      policyFraction = b.totalAmount > 0 ? Math.min(1, refundAmount / b.totalAmount) : 0;
      const refundable = (await refundablePayments(b.id, tx)).reduce((sum, r) => sum + r.remaining, 0);
      refundAmount = Math.max(0, Math.min(refundAmount, refundable, b.totalAmount));
      await shiftInventory(tx, b, { sold: -1 }, b.status === "CHECKED_IN" ? todayIST() : undefined);
    } else {
      await shiftInventory(tx, b, { held: -1 });
    }
    const [u] = await tx
      .update(bookings)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: opts.by,
        cancelReason: opts.reason?.trim() || null,
        refundAmount,
        holdExpiresAt: null,
        channelSyncStatus: wasPaid && b.channelSyncStatus ? "PENDING" : b.channelSyncStatus,
      })
      .where(eq(bookings.id, b.id))
      .returning();
    if (wasPaid) await postCancellationEntries(tx, u, refundAmount, policyFraction);
    return { booking: u, wasPaid };
  });

  if (wasPaid) {
    if (booking.refundAmount > 0)
      await refundAcrossPayments(
        booking,
        booking.refundAmount,
        booking.cancelReason ?? `Cancelled by ${opts.by.toLowerCase()}`,
        opts.actorUserId ?? null,
      );
    notifyLater(sendCancellationEmails(booking));
    refreshPopularityFor(booking.propertyId);
    if (booking.channelSyncStatus) notifyLater(queueReservationPush(booking.id, "CANCEL"));
  }
  return booking;
}

// ─── Partner stay actions ────────────────────────────────────────────────────

export async function markCheckedIn(b: BookingRow) {
  if (b.status !== "CONFIRMED") throw conflict("Only confirmed bookings can be checked in");
  if (todayIST() < b.checkIn) throw conflict("Guests can be checked in from the check-in date");
  const [u] = await db
    .update(bookings)
    .set({ status: "CHECKED_IN", checkedInAt: new Date() })
    .where(and(eq(bookings.id, b.id), eq(bookings.status, "CONFIRMED")))
    .returning();
  if (!u) throw conflict("Booking was updated by someone else, please refresh");
  refreshPopularityFor(u.propertyId);
  return u;
}

export async function markCheckedOut(b: BookingRow) {
  if (b.status !== "CHECKED_IN" && b.status !== "CONFIRMED") throw conflict("Only in-house guests can be checked out");
  if (todayIST() < b.checkIn) throw conflict("This stay has not started yet");
  const [u] = await db
    .update(bookings)
    .set({ status: "COMPLETED", completedAt: new Date(), checkedInAt: b.checkedInAt ?? new Date() })
    .where(and(eq(bookings.id, b.id), inArray(bookings.status, ["CHECKED_IN", "CONFIRMED"])))
    .returning();
  if (!u) throw conflict("Booking was updated by someone else, please refresh");
  return u;
}

/** Guest didn't arrive: prepaid, so the partner keeps the payout; rooms from tomorrow are released for resale. */
export async function markNoShow(b: BookingRow) {
  if (b.status !== "CONFIRMED") throw conflict("Only confirmed bookings can be marked as no-show");
  if (todayIST() < b.checkIn) throw conflict("A no-show can only be recorded from the check-in date");
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(bookings).where(eq(bookings.id, b.id)).for("update");
    if (locked.status !== "CONFIRMED") throw conflict("Booking was updated by someone else, please refresh");
    await shiftInventory(tx, locked, { sold: -1 }, addDays(todayIST(), 1));
    const [u] = await tx.update(bookings).set({ status: "NO_SHOW" }).where(eq(bookings.id, b.id)).returning();
    refreshPopularityFor(u.propertyId);
    return u;
  });
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function expireHolds(): Promise<number> {
  const due = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.status, "PENDING_PAYMENT"), lt(bookings.holdExpiresAt, new Date())))
    .limit(500);
  let n = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (b.status !== "PENDING_PAYMENT" || !b.holdExpiresAt || b.holdExpiresAt >= new Date()) return;
      await shiftInventory(tx, b, { held: -1 });
      await tx.update(bookings).set({ status: "EXPIRED" }).where(eq(bookings.id, id));
      n++;
    });
  }
  return n;
}

/** CONFIRMED / CHECKED_IN stays become COMPLETED the day after check-out. */
export async function completeStays(): Promise<number> {
  const rows = await db
    .update(bookings)
    .set({ status: "COMPLETED", completedAt: new Date() })
    .where(and(inArray(bookings.status, ["CONFIRMED", "CHECKED_IN"]), lt(bookings.checkOut, todayIST())))
    .returning({ id: bookings.id, propertyId: bookings.propertyId });
  if (rows.length) await recalcPopularity([...new Set(rows.map((r) => r.propertyId))]);
  return rows.length;
}

// ─── Emails ──────────────────────────────────────────────────────────────────

export async function emailContext(b: BookingRow) {
  const [p] = await db.select().from(properties).where(eq(properties.id, b.propertyId));
  const [partner] = await db.select().from(partners).where(eq(partners.id, b.partnerId));
  const rooms = await db.select().from(bookingRooms).where(eq(bookingRooms.bookingId, b.id));
  const roomsText = rooms.map((r) => `${r.quantity} × ${r.roomTypeName} (${r.ratePlanName})`).join(", ");
  const partnerEmails = [...new Set([partner?.email, p?.contactEmail].filter(Boolean) as string[])];
  return { p, roomsText, partnerEmails };
}

async function sendConfirmationEmails(b: BookingRow) {
  const { p, roomsText, partnerEmails } = await emailContext(b);
  const stay = `${b.checkIn} → ${b.checkOut} (${b.nights} night${b.nights > 1 ? "s" : ""})`;
  const guestText = [
    `Hi ${b.guestName}, your stay at ${p?.name} is confirmed.`,
    `Booking code: ${b.code}`,
    `Stay: ${stay}, check-in from ${p?.checkInTime ?? "14:00"}`,
    `Rooms: ${roomsText}`,
    `Guests: ${b.adults} adult(s), ${b.children} child(ren)`,
    `Amount paid: ${inr(b.totalAmount)}`,
    `Manage your booking: ${env.webUrl}/account/bookings/${b.code}`,
  ].join("\n");
  await sendEmail({
    to: b.guestEmail,
    subject: `Booking confirmed — ${p?.name} (${b.code})`,
    text: guestText,
    html: `<p>${guestText.replace(/\n/g, "<br>")}</p>`,
  });
  const partnerText = [
    `New booking ${b.code} at ${p?.name}.`,
    `Guest: ${b.guestName}, ${b.guestPhone}, ${b.guestEmail}`,
    `Stay: ${stay}`,
    `Rooms: ${roomsText}`,
    `Guests: ${b.adults} adult(s), ${b.children} child(ren)`,
    b.specialRequests ? `Special requests: ${b.specialRequests}` : "",
    `Prepaid online. Your payout: ${inr(b.partnerPayout)} (settles on/after ${b.settlementDueDate}).`,
  ]
    .filter(Boolean)
    .join("\n");
  for (const to of partnerEmails)
    await sendEmail({
      to,
      subject: `New booking ${b.code} — ${b.checkIn}`,
      text: partnerText,
      html: `<p>${partnerText.replace(/\n/g, "<br>")}</p>`,
    });
}

async function sendCancellationEmails(b: BookingRow) {
  const { p, partnerEmails } = await emailContext(b);
  const guestText = [
    `Hi ${b.guestName}, your booking ${b.code} at ${p?.name} (${b.checkIn} → ${b.checkOut}) has been cancelled.`,
    b.refundAmount > 0
      ? `A refund of ${inr(b.refundAmount)} has been initiated to your original payment method (5–7 working days).`
      : "No refund is applicable as per the cancellation policy.",
  ].join("\n");
  await sendEmail({
    to: b.guestEmail,
    subject: `Booking cancelled — ${b.code}`,
    text: guestText,
    html: `<p>${guestText.replace(/\n/g, "<br>")}</p>`,
  });
  const partnerText = `Booking ${b.code} (${b.guestName}, ${b.checkIn} → ${b.checkOut}) was cancelled${b.cancelReason ? `: ${b.cancelReason}` : ""}. Inventory has been released.`;
  for (const to of partnerEmails)
    await sendEmail({ to, subject: `Booking cancelled — ${b.code}`, text: partnerText, html: `<p>${partnerText}</p>` });
}
