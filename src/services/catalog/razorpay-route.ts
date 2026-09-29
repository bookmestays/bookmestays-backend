// Razorpay Route linked-account onboarding (v2 Accounts API):
//   1. POST /v2/accounts                         (type "route")
//   2. POST /v2/accounts/:id/stakeholders
//   3. POST /v2/accounts/:id/products            (product_name "route")
//   4. PATCH /v2/accounts/:id/products/:pid      (settlement bank details)
// Resumable: the account id is stored right after step 1, and later steps are retried on the next call.
import { eq } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db";
import { partners } from "../../db/schema";
import { AppError, badRequest } from "../../lib/errors";
import { decrypt } from "../../lib/utils";

const BASE = "https://api.razorpay.com";

export const razorpayConfigured = () => !!(env.razorpay.keyId && env.razorpay.keySecret);

async function rzp<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const description = data?.error?.description ?? `Razorpay request failed (${res.status})`;
    throw new AppError(502, "RAZORPAY_ERROR", `Razorpay: ${description}`, { step: path, error: data?.error });
  }
  return data as T;
}

export type LinkedAccountOptions = {
  businessType?: string;
  category?: string;
  subcategory?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
};

export async function createLinkedAccount(
  partner: typeof partners.$inferSelect,
  fallback: { city?: string | null; state?: string | null; pincode?: string | null },
  opts: LinkedAccountOptions = {},
) {
  if (!razorpayConfigured())
    throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Razorpay keys are not configured on the server");
  if (!partner.bankAccountNumberEnc || !partner.bankIfsc || !partner.bankAccountName)
    throw badRequest("Add the partner's bank account name, number and IFSC first");

  const postalCode = opts.postalCode ?? fallback.pincode ?? partner.address?.match(/\b\d{6}\b/)?.[0];
  const city = opts.city ?? fallback.city;
  const state = opts.state ?? fallback.state;
  const street1 = opts.street1 ?? partner.address?.slice(0, 100);
  if (!street1 || !city || !state || !postalCode)
    throw badRequest("Partner address incomplete: street, city, state and PIN code are required", {
      street1,
      city,
      state,
      postalCode,
    });

  let accountId = partner.razorpayLinkedAccountId;
  if (!accountId) {
    const account = await rzp<{ id: string }>("POST", "/v2/accounts", {
      email: partner.email,
      phone: partner.phone.replace(/\D/g, "").slice(-10),
      type: "route",
      reference_id: partner.id.replace(/-/g, "").slice(0, 20),
      legal_business_name: partner.legalName,
      business_type: opts.businessType ?? (partner.gstin ? "private_limited" : "proprietorship"),
      contact_name: partner.contactName,
      profile: {
        category: opts.category ?? "tours_and_travel",
        subcategory: opts.subcategory ?? "accommodation",
        addresses: {
          registered: {
            street1,
            street2: opts.street2 ?? (city as string),
            city,
            state: state.toUpperCase(),
            postal_code: postalCode,
            country: "IN",
          },
        },
      },
      legal_info: {
        ...(partner.pan ? { pan: partner.pan } : {}),
        ...(partner.gstin ? { gst: partner.gstin } : {}),
      },
    });
    accountId = account.id;
    await db.update(partners).set({ razorpayLinkedAccountId: accountId }).where(eq(partners.id, partner.id));
  }

  const stakeholders = await rzp<{ items?: unknown[] }>("GET", `/v2/accounts/${accountId}/stakeholders`);
  if (!stakeholders.items?.length) {
    await rzp("POST", `/v2/accounts/${accountId}/stakeholders`, {
      name: partner.contactName,
      email: partner.email,
      phone: { primary: partner.phone.replace(/\D/g, "").slice(-10) },
      ...(partner.pan ? { kyc: { pan: partner.pan } } : {}),
    });
  }

  const product = await rzp<{ id: string }>("POST", `/v2/accounts/${accountId}/products`, {
    product_name: "route",
    tnc_accepted: true,
  });
  await rzp("PATCH", `/v2/accounts/${accountId}/products/${product.id}`, {
    settlements: {
      account_number: decrypt(partner.bankAccountNumberEnc),
      ifsc_code: partner.bankIfsc,
      beneficiary_name: partner.bankAccountName,
    },
    tnc_accepted: true,
  });
  return accountId;
}
