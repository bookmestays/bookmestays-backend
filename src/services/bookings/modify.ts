// Booking modification: change dates / guests / rooms of a CONFIRMED booking before check-in.
//
// Flow
//   quoteModification → re-prices the new stay (the booking's own rooms count as free) and returns the difference.
//   requestModification →
//     • difference > 0 (and not waived): the change waits in PENDING_PAYMENT. The extra rooms it needs are held
//       (inventory.held) until a supplementary Razorpay order for the difference is paid.
//     • otherwise the change is APPLIED at once; a lower price refunds the difference.
//   confirmModificationPayment (verify endpoint or webhook) → applies a pending change. Idempotent.
//   expireModificationHolds (job) → releases holds of unpaid changes.
//
// Applying a change rewrites the booking's stay + economics + booking_rooms, reverses the old ledger entries and
// posts new ones (so the booking's ledger always sums to its current payout), and pushes an OTA "Modify" message
// to the property's channel manager.
import { and, eq, lt, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { db, type Tx } from "../../db";
import {
  bookingModifications,
  bookingRooms,
  bookings,
  coupons,
  partners,
  payments,
  properties,
  inventory,
  type ModificationQuoteSnapshot,
  type ModificationRoom,
} from "../../db/schema";
import { AppError, conflict, notFound, unprocessable } from "../../lib/errors";
import { notifyLater, sendEmail } from "../../lib/notify";
import { nightsBetween } from "../../lib/utils";
import { activeConnectionFor, queueReservationPush } from "../channel/outbound";
import { postBookingEntries, postBookingReversalEntries } from "../ledger";
import { buildQuote, hoursUntilCheckIn, type QuoteInput } from "../pricing";
import { createOrder, ensureCaptured, paymentsKeyId, type RouteTransfer } from "../razorpay";
import { getBookingSettings } from "../settings";
import { settlementDueDate } from "../settlements/due-date";
import type { BookingRow } from "./dto";
import { emailContext, issueRefund, lockInventory, refundAcrossPayments, refundablePayments } from "./index";

export type ModificationRow = typeof bookingModifications.$inferSelect;
export type ModifyInput = Omit<QuoteInput, "propertyId" | "couponCode">;
export type ModifyActor = { by: "GUEST" | "ADMIN"; userId: string | null; waiveDifference?: boolean; reason?: string | null };

const MIN_HOURS_BEFORE_CHECK_IN_FOR_GUEST = 24;
const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Usage = Map<string, Map<string, number>>; // roomTypeId → date → rooms

function usageOf(rooms: { roomTypeId: string; quantity: number }[], checkIn: string, checkOut: string): Usage {
  const usage: Usage = new Map();
  for (const r of rooms)
    for (const date of nightsBetween(checkIn, checkOut)) {
      const perDate = usage.get(r.roomTypeId) ?? new Map<string, number>();
      perDate.set(date, (perDate.get(date) ?? 0) + r.quantity);
      usage.set(r.roomTypeId, perDate);
    }
  return usage;
}

/** new − old per room type and date (positive = extra rooms needed, negative = rooms freed). */
function usageDelta(oldU: Usage, newU: Usage) {
  const out: { roomTypeId: string; date: string; qty: number }[] = [];
  const keys = new Set([...oldU.keys(), ...newU.keys()]);
  for (const rt of keys) {
    const dates = new Set([...(oldU.get(rt)?.keys() ?? []), ...(newU.get(rt)?.keys() ?? [])]);
    for (const date of dates) {
      const qty = (newU.get(rt)?.get(date) ?? 0) - (oldU.get(rt)?.get(date) ?? 0);
      if (qty !== 0) out.push({ roomTypeId: rt, date, qty });
    }
  }
  return out;
}

async function addInventory(tx: Tx, rows: { roomTypeId: string; date: string; qty: number }[], column: "held" | "sold") {
  for (const r of rows) {
    const col = inventory[column];
    await tx
      .update(inventory)
      .set({ [column]: sql`greatest(0, ${col} + ${r.qty})`, updatedAt: new Date() })
      .where(and(eq(inventory.roomTypeId, r.roomTypeId), eq(inventory.date, r.date)));
  }
}

async function currentRooms(exec: typeof db | Tx, bookingId: string): Promise<ModificationRoom[]> {
  const rows = await exec
    .select({ roomTypeId: bookingRooms.roomTypeId, ratePlanId: bookingRooms.ratePlanId, quantity: bookingRooms.quantity })
    .from(bookingRooms)
    .where(eq(bookingRooms.bookingId, bookingId));
  return rows;
}

function spanOf(a: { checkIn: string; checkOut: string }, b: { checkIn: string; checkOut: string }) {
  return { from: a.checkIn < b.checkIn ? a.checkIn : b.checkIn, to: a.checkOut > b.checkOut ? a.checkOut : b.checkOut };
}

/** Guest-side eligibility (admins can modify any CONFIRMED booking). */
export async function modificationEligibility(b: BookingRow): Promise<{ canModify: boolean; reason?: string }> {
  if (b.status !== "CONFIRMED") return { canModify: false, reason: "Only confirmed bookings can be changed" };
  const [p] = await db.select({ checkInTime: properties.checkInTime }).from(properties).where(eq(properties.id, b.propertyId));
  if (hoursUntilCheckIn(b.checkIn, p?.checkInTime ?? null) < MIN_HOURS_BEFORE_CHECK_IN_FOR_GUEST)
    return { canModify: false, reason: "Bookings can be changed online up to 24 hours before check-in" };
  const refundable = (b.cancellationPolicy?.rules ?? []).some((r) => r.refundPercent > 0);
  if (!refundable) return { canModify: false, reason: "Non-refundable bookings cannot be changed" };
  return { canModify: true };
}

/** Re-prices the requested stay. The booking's current rooms are treated as free. Coupon discount carries over. */
async function priceModification(exec: typeof db | Tx, b: BookingRow, input: ModifyInput) {
  const oldRooms = await currentRooms(exec, b.id);
  const oldUsage = usageOf(oldRooms, b.checkIn, b.checkOut);
  const q = await buildQuote(exec, { ...input, propertyId: b.propertyId }, { userId: b.userId, release: oldUsage });

  // The original coupon's discount is kept (capped so the stay never becomes free); it is not re-validated.
  const coupon = b.couponId ? await exec.query.coupons.findFirst({ where: eq(coupons.id, b.couponId) }) : null;
  const gross = q.roomAmount + q.roomTax;
  const discountAmount = Math.max(0, Math.min(b.discountAmount, gross - 100));
  const partnerFunded = coupon?.fundedBy === "PARTNER" ? discountAmount : 0;
  const totalAmount = gross - discountAmount;
  const partnerPayout = gross - q.commissionAmount - q.commissionTax - q.tcsAmount - q.tdsAmount - partnerFunded;

  const snapshot: ModificationQuoteSnapshot = {
    nights: q.quote.nights,
    roomAmount: q.roomAmount,
    roomTax: q.roomTax,
    addonsAmount: 0,
    discountAmount,
    totalAmount,
    commissionAmount: q.commissionAmount,
    commissionTax: q.commissionTax,
    tcsAmount: q.tcsAmount,
    tdsAmount: q.tdsAmount,
    partnerPayout,
    cancellationPolicy: q.cancellationPolicy,
    lines: q.lines.map((l) => ({
      roomTypeId: l.roomType.id,
      ratePlanId: l.ratePlan.id,
      roomTypeName: l.roomType.name,
      ratePlanName: l.ratePlan.name,
      quantity: l.quantity,
      adults: l.adults,
      children: l.children,
      nightly: l.nightly,
      amount: l.amount,
      commissionType: l.commission.type,
      commissionValue: l.commission.value,
      commissionAmount: l.commissionAmount,
    })),
  };
  const difference = totalAmount - b.totalAmount;
  const action = difference > 0 ? ("PAY" as const) : difference < 0 ? ("REFUND" as const) : ("NONE" as const);
  const quote = {
    ...q.quote,
    discountAmount,
    totalAmount,
    coupon: q.quote.coupon ?? null,
  };
  return { quote, snapshot, difference, action, oldRooms, oldUsage, newUsage: usageOf(input.rooms, input.checkIn, input.checkOut) };
}

// ─── Quote ───────────────────────────────────────────────────────────────────

export async function quoteModification(b: BookingRow, input: ModifyInput, actor: ModifyActor) {
  if (actor.by === "GUEST") {
    const e = await modificationEligibility(b);
    if (!e.canModify) throw conflict(e.reason!);
  } else if (b.status !== "CONFIRMED") throw conflict("Only confirmed bookings can be changed");
  const priced = await priceModification(db, b, input);
  return {
    ...priced.quote,
    currentTotal: b.totalAmount,
    difference: priced.difference,
    action: priced.action,
  };
}

// ─── Request ─────────────────────────────────────────────────────────────────

export async function requestModification(bookingId: string, input: ModifyInput, actor: ModifyActor) {
  const pre = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!pre) throw notFound("Booking");
  if (actor.by === "GUEST") {
    const e = await modificationEligibility(pre);
    if (!e.canModify) throw conflict(e.reason!);
  }
  const settings = await getBookingSettings();

  // An older unpaid change is replaced by the new request.
  await cancelPendingModifications(bookingId, "Replaced by a newer change request");

  const result = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (b.status !== "CONFIRMED") throw conflict("Only confirmed bookings can be changed");
    const oldRooms = await currentRooms(tx, b.id);
    const span = spanOf(b, input);
    const rtIds = [...new Set([...oldRooms.map((r) => r.roomTypeId), ...input.rooms.map((r) => r.roomTypeId)])].sort();
    await lockInventory(tx, rtIds, span.from, span.to);

    const priced = await priceModification(tx, b, input);
    const delta = usageDelta(priced.oldUsage, priced.newUsage);
    const waived = actor.by === "ADMIN" && !!actor.waiveDifference && priced.action !== "NONE";
    const needsPayment = priced.action === "PAY" && !waived;

    const [mod] = await tx
      .insert(bookingModifications)
      .values({
        bookingId: b.id,
        status: needsPayment ? "PENDING_PAYMENT" : "APPLIED",
        requestedBy: actor.by,
        actorUserId: actor.userId,
        fromCheckIn: b.checkIn,
        fromCheckOut: b.checkOut,
        fromAdults: b.adults,
        fromChildren: b.children,
        fromRooms: oldRooms,
        fromTotal: b.totalAmount,
        fromPayout: b.partnerPayout,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.children,
        rooms: input.rooms,
        quote: priced.snapshot,
        difference: priced.difference,
        action: priced.action,
        waived,
        heldInventory: needsPayment ? delta.filter((d) => d.qty > 0) : null,
        holdExpiresAt: needsPayment ? new Date(Date.now() + settings.holdMinutes * 60_000) : null,
        reason: actor.reason?.trim() || null,
        appliedAt: needsPayment ? null : new Date(),
      })
      .returning();

    if (needsPayment) {
      await addInventory(tx, delta.filter((d) => d.qty > 0), "held");
      return { booking: b, mod, applied: null as BookingRow | null };
    }
    await addInventory(tx, delta, "sold");
    const applied = await writeModification(tx, b, mod);
    return { booking: applied, mod, applied };
  });

  if (result.applied) {
    await afterApplied(result.applied, result.mod, actor);
    return { booking: result.applied, modification: result.mod, payment: null };
  }

  // Supplementary payment for the difference
  try {
    const payment = await createModificationPayment(result.booking, result.mod);
    if (actor.by === "ADMIN") notifyLater(sendPaymentRequestEmail(result.booking, result.mod));
    return { booking: result.booking, modification: result.mod, payment: modificationOrderDto(result.booking, result.mod, payment) };
  } catch (err) {
    await cancelPendingModifications(bookingId, "Could not create the payment order");
    throw err;
  }
}

/** Writes the new stay + economics onto the booking, swaps booking_rooms and re-posts the ledger. */
async function writeModification(tx: Tx, b: BookingRow, mod: ModificationRow): Promise<BookingRow> {
  const s = mod.quote;
  const [partner] = await tx.select().from(partners).where(eq(partners.id, b.partnerId));
  const conn = await activeConnectionFor(b.propertyId, tx);
  const [u] = await tx
    .update(bookings)
    .set({
      checkIn: mod.checkIn,
      checkOut: mod.checkOut,
      nights: s.nights,
      adults: mod.adults,
      children: mod.children,
      roomAmount: s.roomAmount,
      roomTax: s.roomTax,
      addonsAmount: s.addonsAmount,
      discountAmount: s.discountAmount,
      totalAmount: s.totalAmount,
      commissionAmount: s.commissionAmount,
      commissionTax: s.commissionTax,
      tcsAmount: s.tcsAmount,
      tdsAmount: s.tdsAmount,
      partnerPayout: s.partnerPayout,
      cancellationPolicy: s.cancellationPolicy,
      settlementDueDate: settlementDueDate(partner, mod.checkOut),
      channelSyncStatus: conn ? "PENDING" : b.channelSyncStatus,
    })
    .where(eq(bookings.id, b.id))
    .returning();
  await tx.delete(bookingRooms).where(eq(bookingRooms.bookingId, b.id));
  await tx.insert(bookingRooms).values(
    s.lines.map((l) => ({
      bookingId: b.id,
      roomTypeId: l.roomTypeId,
      ratePlanId: l.ratePlanId,
      roomTypeName: l.roomTypeName,
      ratePlanName: l.ratePlanName,
      quantity: l.quantity,
      adults: l.adults,
      children: l.children,
      nightlyPrices: l.nightly,
      amount: l.amount,
      commissionType: l.commissionType,
      commissionValue: l.commissionValue,
      commissionAmount: l.commissionAmount,
    })),
  );
  const meta = { modificationId: mod.id };
  await postBookingReversalEntries(tx, b, meta);
  await postBookingEntries(tx, u, meta);
  return u;
}

async function afterApplied(b: BookingRow, mod: ModificationRow, actor: ModifyActor | null) {
  if (mod.action === "REFUND" && !mod.waived) {
    const refunds = await refundAcrossPayments(
      b,
      -mod.difference,
      `Booking ${b.code} changed (${mod.fromCheckIn} → ${mod.checkIn})`,
      actor?.userId ?? null,
    );
    if (refunds[0]) await db.update(bookingModifications).set({ refundId: refunds[0].id }).where(eq(bookingModifications.id, mod.id));
  }
  notifyLater(sendModifiedEmails(b, mod));
  notifyLater(queueReservationPush(b.id, "MODIFY"));
}

// ─── Supplementary payment ───────────────────────────────────────────────────

const endOfDayIstUnix = (date: string) => Math.floor(new Date(`${date}T23:59:59+05:30`).getTime() / 1000);

async function createModificationPayment(b: BookingRow, mod: ModificationRow) {
  const [partner] = await db.select().from(partners).where(eq(partners.id, b.partnerId));
  const payoutIncrease = mod.quote.partnerPayout - b.partnerPayout;
  const due = settlementDueDate(partner, mod.checkOut);
  const transfer: RouteTransfer | null =
    env.razorpay.routeEnabled && partner.razorpayLinkedAccountId && payoutIncrease > 0
      ? {
          account: partner.razorpayLinkedAccountId,
          amount: Math.min(payoutIncrease, mod.difference),
          onHoldUntil: endOfDayIstUnix(due),
          notes: { bookingCode: b.code, modificationId: mod.id, partnerId: partner.id },
        }
      : null;
  const order = await createOrder({
    amount: mod.difference,
    receipt: `${b.code}-M`,
    notes: { bookingCode: b.code, bookingId: b.id, modificationId: mod.id },
    transfer,
  });
  const [payment] = await db
    .insert(payments)
    .values({
      bookingId: b.id,
      providerOrderId: order.id,
      amount: mod.difference,
      status: "CREATED",
      raw: { order: order.raw, routeTransfer: transfer, modificationId: mod.id },
    })
    .returning();
  await db.update(bookingModifications).set({ paymentId: payment.id }).where(eq(bookingModifications.id, mod.id));
  return payment;
}

export function modificationOrderDto(b: BookingRow, mod: ModificationRow, p: typeof payments.$inferSelect) {
  return {
    provider: "RAZORPAY" as const,
    keyId: paymentsKeyId(),
    orderId: p.providerOrderId!,
    amount: p.amount,
    currency: "INR" as const,
    holdExpiresAt: (mod.holdExpiresAt ?? new Date()).toISOString(),
    prefill: { name: b.guestName, email: b.guestEmail, contact: b.guestPhone },
  };
}

/** Payment order for a pending change (reuses the open order). */
export async function modificationPaymentOrder(b: BookingRow, mod: ModificationRow) {
  if (mod.status !== "PENDING_PAYMENT") throw conflict("This change is not awaiting payment");
  if (!mod.holdExpiresAt || mod.holdExpiresAt < new Date())
    throw new AppError(410, "HOLD_EXPIRED", "This change request has expired. Please request the change again.");
  const payment = mod.paymentId
    ? await db.query.payments.findFirst({ where: eq(payments.id, mod.paymentId) })
    : await createModificationPayment(b, mod);
  if (!payment) throw notFound("Payment");
  return modificationOrderDto(b, mod, payment);
}

/** Returns the pending modification that owns a payment order, if any (used by confirmPayment / webhook). */
export async function modificationForPayment(paymentId: string) {
  return db.query.bookingModifications.findFirst({ where: eq(bookingModifications.paymentId, paymentId) });
}

export type ModificationOutcome = "APPLIED" | "ALREADY" | "REFUNDED";

/** Applies a pending change once its supplementary payment is captured. Idempotent. */
export async function confirmModificationPayment(p: {
  orderId: string;
  paymentId: string;
  method?: string | null;
  raw?: unknown;
  verifyWithGateway?: boolean;
}): Promise<{ booking: BookingRow; modification: ModificationRow; outcome: ModificationOutcome }> {
  const [pre] = await db.select().from(payments).where(eq(payments.providerOrderId, p.orderId));
  if (!pre) throw notFound("Payment");
  let method = p.method ?? null;
  let raw = p.raw;
  if (p.verifyWithGateway && pre.status !== "CAPTURED") {
    const captured = await ensureCaptured(p.paymentId, pre.amount);
    method ??= captured.method;
    raw ??= captured.raw;
  }

  const result = await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, pre.id)).for("update");
    const [mod] = await tx
      .select()
      .from(bookingModifications)
      .where(eq(bookingModifications.paymentId, payment.id))
      .for("update");
    if (!mod) throw notFound("Change request");
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, mod.bookingId)).for("update");

    if (payment.status !== "CAPTURED" && payment.status !== "REFUNDED" && payment.status !== "PARTIALLY_REFUNDED")
      await tx
        .update(payments)
        .set({
          status: "CAPTURED",
          providerPaymentId: p.paymentId,
          method: method ?? payment.method,
          raw: { ...((payment.raw as object) ?? {}), capture: raw ?? null },
        })
        .where(eq(payments.id, payment.id));

    if (mod.status === "APPLIED") return { booking: b, mod, outcome: "ALREADY" as const };

    const oldRooms = await currentRooms(tx, b.id);
    const oldUsage = usageOf(oldRooms, b.checkIn, b.checkOut);
    const newUsage = usageOf(mod.rooms, mod.checkIn, mod.checkOut);
    const delta = usageDelta(oldUsage, newUsage);
    const span = spanOf(b, mod);
    const rtIds = [...new Set(delta.map((d) => d.roomTypeId))].sort();
    const locked = await lockInventory(tx, rtIds, span.from, span.to);

    let usable = b.status === "CONFIRMED" && mod.status === "PENDING_PAYMENT";
    if (!usable && b.status === "CONFIRMED" && mod.status === "EXPIRED") {
      // Hold ran out before the payment arrived — take the extra rooms again if they are still free
      usable = delta
        .filter((d) => d.qty > 0)
        .every((d) => {
          const row = locked.find((r) => r.roomTypeId === d.roomTypeId && r.date === d.date);
          return !!row && !row.stopSell && row.total - row.sold - row.held - row.blocked >= d.qty;
        });
    }
    if (!usable) {
      const [cancelled] = await tx
        .update(bookingModifications)
        .set({ status: "CANCELLED", reason: "Rooms or booking no longer available when the payment completed" })
        .where(eq(bookingModifications.id, mod.id))
        .returning();
      return { booking: b, mod: cancelled, outcome: "REFUNDED" as const };
    }

    if (mod.status === "PENDING_PAYMENT") await addInventory(tx, (mod.heldInventory ?? []).map((h) => ({ ...h, qty: -h.qty })), "held");
    await addInventory(tx, delta, "sold");
    const [applied] = await tx
      .update(bookingModifications)
      .set({ status: "APPLIED", appliedAt: new Date(), holdExpiresAt: null })
      .where(eq(bookingModifications.id, mod.id))
      .returning();
    const booking = await writeModification(tx, b, applied);
    return { booking, mod: applied, outcome: "APPLIED" as const };
  });

  if (result.outcome === "APPLIED") await afterApplied(result.booking, result.mod, null);
  if (result.outcome === "REFUNDED") {
    const payment = (await refundablePayments(result.booking.id)).find((r) => r.payment.id === pre.id);
    if (payment) await issueRefund(result.booking, payment.payment, payment.remaining, "Booking change could not be applied", null);
  }
  return { booking: result.booking, modification: result.mod, outcome: result.outcome };
}

// ─── Cancel / expire pending changes ─────────────────────────────────────────

async function releaseHeld(tx: Tx, mod: ModificationRow) {
  if (mod.heldInventory?.length) await addInventory(tx, mod.heldInventory.map((h) => ({ ...h, qty: -h.qty })), "held");
}

export async function cancelPendingModifications(bookingId: string, reason: string) {
  await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(bookingModifications)
      .where(and(eq(bookingModifications.bookingId, bookingId), eq(bookingModifications.status, "PENDING_PAYMENT")))
      .for("update");
    for (const mod of pending) {
      await releaseHeld(tx, mod);
      await tx
        .update(bookingModifications)
        .set({ status: "CANCELLED", reason, holdExpiresAt: null })
        .where(eq(bookingModifications.id, mod.id));
    }
  });
}

/** Job: unpaid changes past their hold release the extra rooms they were holding. */
export async function expireModificationHolds(): Promise<number> {
  const due = await db
    .select({ id: bookingModifications.id })
    .from(bookingModifications)
    .where(and(eq(bookingModifications.status, "PENDING_PAYMENT"), lt(bookingModifications.holdExpiresAt, new Date())));
  let n = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [mod] = await tx.select().from(bookingModifications).where(eq(bookingModifications.id, id)).for("update");
      if (mod.status !== "PENDING_PAYMENT") return;
      await releaseHeld(tx, mod);
      await tx
        .update(bookingModifications)
        .set({ status: "EXPIRED", holdExpiresAt: null })
        .where(eq(bookingModifications.id, id));
      n++;
    });
  }
  return n;
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

export async function modificationDto(mod: ModificationRow, b?: BookingRow) {
  const payment =
    mod.status === "PENDING_PAYMENT" && mod.paymentId && b
      ? await db.query.payments.findFirst({ where: eq(payments.id, mod.paymentId) })
      : null;
  return {
    id: mod.id,
    status: mod.status,
    requestedBy: mod.requestedBy as "GUEST" | "ADMIN",
    from: {
      checkIn: mod.fromCheckIn,
      checkOut: mod.fromCheckOut,
      adults: mod.fromAdults,
      children: mod.fromChildren,
      totalAmount: mod.fromTotal,
    },
    to: {
      checkIn: mod.checkIn,
      checkOut: mod.checkOut,
      adults: mod.adults,
      children: mod.children,
      totalAmount: mod.quote.totalAmount,
      rooms: mod.quote.lines.map((l) => ({
        roomTypeName: l.roomTypeName,
        ratePlanName: l.ratePlanName,
        quantity: l.quantity,
        amount: l.amount,
      })),
    },
    difference: mod.difference,
    action: mod.action as "PAY" | "REFUND" | "NONE",
    waived: mod.waived,
    reason: mod.reason,
    holdExpiresAt: mod.holdExpiresAt?.toISOString() ?? null,
    appliedAt: mod.appliedAt?.toISOString() ?? null,
    createdAt: mod.createdAt.toISOString(),
    payment: payment && b ? modificationOrderDto(b, mod, payment) : null,
  };
}

export async function listModifications(bookingId: string) {
  return db
    .select()
    .from(bookingModifications)
    .where(eq(bookingModifications.bookingId, bookingId))
    .orderBy(sql`${bookingModifications.createdAt} desc`);
}

// ─── Emails ──────────────────────────────────────────────────────────────────

async function sendModifiedEmails(b: BookingRow, mod: ModificationRow) {
  const { p, roomsText, partnerEmails } = await emailContext(b);
  const money =
    mod.action === "PAY"
      ? mod.waived
        ? "The price difference has been waived."
        : `You paid the difference of ${inr(mod.difference)}.`
      : mod.action === "REFUND"
        ? mod.waived
          ? "No refund applies to this change."
          : `A refund of ${inr(-mod.difference)} has been initiated to your original payment method (5–7 working days).`
        : "The price is unchanged.";
  const guestText = [
    `Hi ${b.guestName}, your booking ${b.code} at ${p?.name} has been changed.`,
    `New stay: ${b.checkIn} → ${b.checkOut}, ${b.adults} adult(s)${b.children ? `, ${b.children} child(ren)` : ""}.`,
    `Rooms: ${roomsText}. New total: ${inr(b.totalAmount)}.`,
    money,
  ].join("\n");
  await sendEmail({ to: b.guestEmail, subject: `Booking changed — ${b.code}`, text: guestText, html: `<p>${guestText.replace(/\n/g, "<br>")}</p>` });
  const partnerText = [
    `Booking ${b.code} (${b.guestName}) was changed.`,
    `Was: ${mod.fromCheckIn} → ${mod.fromCheckOut}. Now: ${b.checkIn} → ${b.checkOut}, ${roomsText}.`,
    `Your payout is now ${inr(b.partnerPayout)}.`,
  ].join("\n");
  for (const to of partnerEmails)
    await sendEmail({ to, subject: `Booking changed — ${b.code}`, text: partnerText, html: `<p>${partnerText.replace(/\n/g, "<br>")}</p>` });
}

async function sendPaymentRequestEmail(b: BookingRow, mod: ModificationRow) {
  const text = [
    `Hi ${b.guestName}, we've prepared a change to your booking ${b.code}: ${mod.checkIn} → ${mod.checkOut}.`,
    `To confirm it, please pay the difference of ${inr(mod.difference)} before ${mod.holdExpiresAt?.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}:`,
    `${env.webUrl}/account/bookings/${b.code}`,
  ].join("\n");
  await sendEmail({ to: b.guestEmail, subject: `Confirm the change to booking ${b.code}`, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
}

