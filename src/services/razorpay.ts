// Razorpay integration: orders (with optional Route transfers), signature checks, refunds,
// Route transfer release, and RazorpayX payouts (REST — the node SDK does not cover RazorpayX).
//
// MOCK MODE (API_CONTRACT §9): when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are empty and NODE_ENV is not
// production, nothing is sent to Razorpay: orders get ids "order_mock_<id>", keyId "MOCK", signature
// "MOCK" is accepted, and refunds / transfers / payouts are recorded as processed immediately.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import Razorpay from "razorpay";
import { env } from "../config/env";
import { db } from "../db";
import { partners } from "../db/schema";
import { AppError, badRequest } from "../lib/errors";
import { decrypt } from "../lib/utils";

export const isMockPayments = () => !env.isProd && (!env.razorpay.keyId || !env.razorpay.keySecret);
export const paymentsKeyId = () => (isMockPayments() ? "MOCK" : env.razorpay.keyId);
export const mockId = (prefix: string) => `${prefix}_mock_${randomBytes(7).toString("hex")}`;

let client: Razorpay | null = null;
function rzp(): Razorpay {
  if (!env.razorpay.keyId || !env.razorpay.keySecret)
    throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Online payments are temporarily unavailable");
  client ??= new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret });
  return client;
}

/** Razorpay SDK errors look like { statusCode, error: { code, description } }. */
export function razorpayErrorMessage(err: unknown): string {
  const e = err as { error?: { description?: string; code?: string }; message?: string };
  return e?.error?.description ?? e?.message ?? String(err);
}

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

// ─── Orders ──────────────────────────────────────────────────────────────────

export type RouteTransfer = { account: string; amount: number; onHoldUntil: number; notes: Record<string, string> };

export async function createOrder(params: {
  amount: number;
  receipt: string;
  notes: Record<string, string>;
  transfer?: RouteTransfer | null;
}): Promise<{ id: string; raw: unknown }> {
  if (isMockPayments()) {
    const id = `order_mock_${randomBytes(7).toString("hex")}`;
    return { id, raw: { mock: true, id, amount: params.amount, transfer: params.transfer ?? null } };
  }
  const body: Record<string, unknown> = {
    amount: params.amount,
    currency: "INR",
    receipt: params.receipt,
    notes: params.notes,
    payment_capture: 1,
  };
  if (params.transfer)
    body.transfers = [
      {
        account: params.transfer.account,
        amount: params.transfer.amount,
        currency: "INR",
        on_hold: 1,
        on_hold_until: params.transfer.onHoldUntil,
        notes: params.transfer.notes,
      },
    ];
  try {
    const order = await rzp().orders.create(body as never);
    return { id: order.id, raw: order };
  } catch (err) {
    throw new AppError(502, "PAYMENT_GATEWAY_ERROR", "Could not start the payment. Please try again.", {
      gateway: razorpayErrorMessage(err),
    });
  }
}

// ─── Signatures ──────────────────────────────────────────────────────────────

/** Checkout signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  if (isMockPayments()) return signature === "MOCK";
  const expected = createHmac("sha256", env.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(expected, signature);
}

/** Webhook signature = HMAC_SHA256(raw body, webhook secret). Mock mode without a secret accepts all. */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!env.razorpay.webhookSecret) return !env.isProd;
  if (!signature) return false;
  const expected = createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

// ─── Payments / refunds / transfers ──────────────────────────────────────────

/** Makes sure an authorized payment is captured (orders use payment_capture=1, this is a fallback). */
export async function ensureCaptured(paymentId: string, amount: number): Promise<{ method: string | null; raw: unknown }> {
  if (isMockPayments()) return { method: "mock", raw: { mock: true, id: paymentId } };
  const api = rzp();
  let payment = await api.payments.fetch(paymentId);
  if (payment.status === "authorized") payment = await api.payments.capture(paymentId, amount, "INR");
  if (payment.status !== "captured")
    throw new AppError(402, "PAYMENT_NOT_CAPTURED", "Payment was not completed. Please try again.");
  return { method: payment.method ?? null, raw: payment };
}

export async function refundPayment(
  paymentId: string,
  amount: number,
  opts: { reverseAll: boolean; notes: Record<string, string> },
): Promise<{ id: string; status: "PROCESSED" | "PENDING"; raw: unknown }> {
  if (isMockPayments() || paymentId.startsWith("pay_mock_"))
    return { id: mockId("rfnd"), status: "PROCESSED", raw: { mock: true, amount } };
  const body: Record<string, unknown> = { amount, speed: "normal", notes: opts.notes };
  if (opts.reverseAll) body.reverse_all = 1;
  const refund = await rzp().payments.refund(paymentId, body as never);
  return { id: refund.id, status: refund.status === "processed" ? "PROCESSED" : "PENDING", raw: refund };
}

export async function fetchPaymentTransfers(paymentId: string) {
  const res = (await rzp().payments.fetchTransfer(paymentId)) as { items?: unknown[] };
  return (res.items ?? []) as {
    id: string;
    amount: number;
    recipient: string;
    on_hold: boolean | number;
    on_hold_until?: number | null;
    status: string;
  }[];
}

/** Releases a Route transfer that was kept on hold until settlement. */
export async function releaseTransfer(transferId: string): Promise<unknown> {
  if (isMockPayments() || transferId.startsWith("trf_mock_")) return { mock: true, id: transferId, on_hold: 0 };
  return rzp().transfers.edit(transferId, { on_hold: 0 });
}

// ─── RazorpayX payouts (REST) ────────────────────────────────────────────────

async function razorpayX<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  const auth = Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64");
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "X-Payout-Idempotency": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new Error(json?.error?.description ?? `RazorpayX ${path} failed (${res.status})`);
  return json;
}

/** Creates RazorpayX contact + bank fund account for the partner on demand (from encrypted bank details). */
export async function ensureFundAccount(partnerId: string): Promise<string> {
  const [p] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!p) throw badRequest("Partner not found");
  if (p.razorpayxFundAccountId) return p.razorpayxFundAccountId;
  if (isMockPayments()) {
    const fa = mockId("fa");
    await db.update(partners).set({ razorpayxContactId: mockId("cont"), razorpayxFundAccountId: fa }).where(eq(partners.id, p.id));
    return fa;
  }
  if (!p.bankAccountNumberEnc || !p.bankIfsc || !p.bankAccountName)
    throw badRequest("Partner bank details are incomplete — add account name, number and IFSC first");
  let contactId = p.razorpayxContactId;
  if (!contactId) {
    const contact = await razorpayX<{ id: string }>("/contacts", {
      name: p.legalName,
      email: p.email,
      contact: p.phone,
      type: "vendor",
      reference_id: p.id.slice(0, 40),
    });
    contactId = contact.id;
  }
  const fa = await razorpayX<{ id: string }>("/fund_accounts", {
    contact_id: contactId,
    account_type: "bank_account",
    bank_account: { name: p.bankAccountName, ifsc: p.bankIfsc, account_number: decrypt(p.bankAccountNumberEnc) },
  });
  await db
    .update(partners)
    .set({ razorpayxContactId: contactId, razorpayxFundAccountId: fa.id })
    .where(eq(partners.id, p.id));
  return fa.id;
}

export type PayoutResult = { id: string; status: string; utr: string | null; mode: string; raw: unknown };

export async function createPayout(params: {
  fundAccountId: string;
  amount: number;
  referenceId: string;
  narration: string;
  idempotencyKey: string;
}): Promise<PayoutResult> {
  // IMPS is limited to ₹5,00,000 per transfer
  const mode = params.amount <= 5_00_000_00 ? "IMPS" : "NEFT";
  if (isMockPayments())
    return {
      id: mockId("pout"),
      status: "processed",
      utr: `MOCKUTR${randomBytes(5).toString("hex").toUpperCase()}`,
      mode,
      raw: { mock: true },
    };
  if (!env.razorpay.xAccountNumber) throw badRequest("RazorpayX is not configured (RAZORPAYX_ACCOUNT_NUMBER)");
  const payout = await razorpayX<{ id: string; status: string; utr?: string | null }>(
    "/payouts",
    {
      account_number: env.razorpay.xAccountNumber,
      fund_account_id: params.fundAccountId,
      amount: params.amount,
      currency: "INR",
      mode,
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: params.referenceId.slice(0, 40),
      narration: params.narration.slice(0, 30),
    },
    params.idempotencyKey,
  );
  return { id: payout.id, status: payout.status, utr: payout.utr ?? null, mode, raw: payout };
}
