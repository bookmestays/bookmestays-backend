// POST /webhooks/razorpay — signature over the RAW body, idempotent through webhook_events.event_id.
// Non-2xx makes Razorpay retry, so failures while processing return 500 and are re-processed on retry.
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../../db";
import { bookings, payments, paymentTransfers, refunds, webhookEvents } from "../../db/schema";
import { sha256 } from "../../lib/utils";
import { confirmPayment } from "../../services/bookings";
import { verifyWebhookSignature } from "../../services/razorpay";
import { handlePayoutEvent } from "../../services/settlements";

type RzpEvent = { event: string; payload: Record<string, { entity: Record<string, any> }> };

async function processEvent(evt: RzpEvent) {
  const [group] = evt.event.split(".");
  switch (group) {
    case "payment":
    case "order": {
      const p = evt.payload.payment?.entity;
      if (!p?.order_id) return;
      if (evt.event === "payment.captured" || evt.event === "order.paid") {
        const [row] = await db.select({ id: payments.id }).from(payments).where(eq(payments.providerOrderId, p.order_id));
        if (row) await confirmPayment({ orderId: p.order_id, paymentId: p.id, method: p.method ?? null, raw: p });
      } else if (evt.event === "payment.failed") {
        await db
          .update(payments)
          .set({ status: "FAILED", errorCode: p.error_code ?? null, errorDescription: p.error_description ?? null })
          .where(and(eq(payments.providerOrderId, p.order_id), inArray(payments.status, ["CREATED", "AUTHORIZED"])));
      }
      return;
    }
    case "refund": {
      const r = evt.payload.refund?.entity;
      if (!r?.id) return;
      const status = evt.event === "refund.processed" ? "PROCESSED" : evt.event === "refund.failed" ? "FAILED" : null;
      if (status) await db.update(refunds).set({ status, raw: r }).where(eq(refunds.providerRefundId, r.id));
      return;
    }
    case "transfer": {
      const tr = evt.payload.transfer?.entity;
      if (!tr?.id) return;
      const status =
        evt.event === "transfer.failed"
          ? "FAILED"
          : evt.event === "transfer.reversed"
            ? "REVERSED"
            : evt.event === "transfer.settled"
              ? "SETTLED"
              : tr.on_hold
                ? "ON_HOLD"
                : "RELEASED";
      const [existing] = await db.select().from(paymentTransfers).where(eq(paymentTransfers.providerTransferId, tr.id));
      if (existing) {
        // never move a transfer we already released back to ON_HOLD because of an older event
        const keep = existing.status === "RELEASED" && status === "ON_HOLD";
        await db
          .update(paymentTransfers)
          .set({ status: keep ? existing.status : status, raw: tr, amountReversed: tr.amount_reversed ?? existing.amountReversed })
          .where(eq(paymentTransfers.id, existing.id));
      } else if (typeof tr.source === "string") {
        const [pay] = await db.select().from(payments).where(eq(payments.providerPaymentId, tr.source));
        if (pay) {
          const [b] = await db.select().from(bookings).where(eq(bookings.id, pay.bookingId));
          if (b)
            await db
              .insert(paymentTransfers)
              .values({
                paymentId: pay.id,
                bookingId: b.id,
                partnerId: b.partnerId,
                providerTransferId: tr.id,
                amount: tr.amount,
                onHoldUntil: b.settlementDueDate,
                status,
                raw: tr,
              })
              .onConflictDoNothing();
        }
      }
      return;
    }
    case "payout": {
      const po = evt.payload.payout?.entity;
      if (po?.id) await handlePayoutEvent(po as { id: string });
      return;
    }
  }
}

export const razorpayWebhookModule = new Elysia({ tags: ["Webhooks"] }).post(
  "/webhooks/razorpay",
  async ({ body, headers, set }) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body ?? {});
    if (!verifyWebhookSignature(raw, headers["x-razorpay-signature"])) {
      set.status = 400;
      return { error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature" } };
    }
    let evt: RzpEvent;
    try {
      evt = JSON.parse(raw) as RzpEvent;
    } catch {
      set.status = 400;
      return { error: { code: "BAD_REQUEST", message: "Invalid JSON" } };
    }
    if (!evt?.event) {
      set.status = 400;
      return { error: { code: "BAD_REQUEST", message: "Missing event" } };
    }
    const eventId = headers["x-razorpay-event-id"] ?? `sha256:${sha256(raw)}`;
    const inserted = await db
      .insert(webhookEvents)
      .values({ provider: "RAZORPAY", eventId, type: evt.event, payload: evt })
      .onConflictDoNothing({ target: webhookEvents.eventId })
      .returning({ id: webhookEvents.id });
    if (!inserted.length) {
      const [existing] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, eventId));
      if (existing?.processedAt) return { ok: true, duplicate: true };
    }
    try {
      await processEvent(evt);
      await db.update(webhookEvents).set({ processedAt: new Date(), error: null }).where(eq(webhookEvents.eventId, eventId));
      return { ok: true };
    } catch (err) {
      console.error("razorpay webhook failed", evt.event, err);
      await db
        .update(webhookEvents)
        .set({ error: (err as Error).message?.slice(0, 1000) ?? "error" })
        .where(eq(webhookEvents.eventId, eventId));
      set.status = 500;
      return { ok: false };
    }
  },
  { parse: "text" },
);
