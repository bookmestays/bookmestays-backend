// WhatsApp sender (AiSensy API Campaigns). Provider is chosen by env; "console" just logs (development).
//
// How AiSensy works (one-time setup in the dashboard):
//   1. Create + get approval for each WhatsApp template (Authentication for OTP, Utility for bookings).
//   2. Campaigns → Launch campaign → API campaign → pick the approved template → Set Live.
//   3. Copy the campaign name into the matching AISENSY_CAMPAIGN_* env var (names must match exactly).
//   4. Manage → API Key → copy the JWT into AISENSY_API_KEY.
//
// Each template's body placeholders ({{1}}, {{2}} …) are filled, in order, by `templateParams`.
// The param order each template expects is documented on the wrapper functions below — create your
// AiSensy templates with the body variables in that same order.

import { env } from "../config/env";

export type WhatsAppMessage = {
  campaignName: string;
  /** Recipient phone in any format; normalized to AiSensy's `91XXXXXXXXXX` form here. */
  destination: string;
  userName?: string;
  /** Body variables, in template order. Non-strings are stringified. */
  templateParams?: (string | number)[];
  /** Extra AiSensy fields (e.g. copy-code button params for authentication templates). */
  buttons?: unknown[];
  media?: Record<string, unknown>;
};

/** AiSensy expects the destination with a country code and no `+` (e.g. 919876543210). */
function toDestination(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1); // 0XXXXXXXXXX → drop trunk 0
  if (digits.length === 10) return `91${digits}`; // bare 10-digit Indian number
  return digits; // already carries a country code
}

/** Send a WhatsApp template message via an AiSensy API campaign. Throws on transport/API error. */
export async function sendWhatsApp(msg: WhatsAppMessage): Promise<void> {
  const { provider, apiKey, apiUrl, senderName } = env.whatsapp;
  const destination = toDestination(msg.destination);

  // No provider configured, no key, or no campaign set up yet → log instead of failing the request.
  if (provider === "console" || !apiKey || !msg.campaignName) {
    console.log(
      `\n💬 [whatsapp:${destination || "??"}] campaign="${msg.campaignName || "(unset)"}" ` +
        `params=${JSON.stringify((msg.templateParams ?? []).map(String))}\n`,
    );
    return;
  }

  if (!destination || destination.length < 11) {
    throw new Error(`Invalid WhatsApp destination for campaign "${msg.campaignName}"`);
  }

  const payload: Record<string, unknown> = {
    apiKey,
    campaignName: msg.campaignName,
    destination,
    userName: msg.userName || senderName || "BookMeStays",
    source: "bookmestays-api",
    templateParams: (msg.templateParams ?? []).map(String),
  };
  if (msg.buttons) payload.buttons = msg.buttons;
  if (msg.media) payload.media = msg.media;

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AiSensy ${res.status} on "${msg.campaignName}": ${detail.slice(0, 300)}`);
  }
}

/** Fire-and-forget wrapper so WhatsApp failures never break a request. */
export const notifyWhatsAppLater = (p: Promise<unknown>) =>
  p.catch((err) => console.error("WhatsApp notification failed:", err));

// ─── Template wrappers ───────────────────────────────────────────────────────
// The comment above each function is the template body your AiSensy template must match.

/**
 * OTP / login code. Authentication template.
 *   Body:   {{1}} is your BookMeStays verification code. …
 *   Button: Copy code  (copy-code button carrying the same code)
 */
export function sendWhatsAppOtp(phone: string, code: string): Promise<void> {
  const buttons = env.whatsapp.otpCopyCodeButton
    ? [{ type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: code }] }]
    : undefined;
  return sendWhatsApp({
    campaignName: env.whatsapp.campaigns.otp,
    destination: phone,
    templateParams: [code],
    buttons,
  });
}

/**
 * Booking confirmed → guest. Utility template. Param order:
 *   {{1}} guest name   {{2}} property   {{3}} booking code
 *   {{4}} check-in     {{5}} check-out  {{6}} amount paid
 */
export function sendWhatsAppBookingGuest(o: {
  phone: string;
  guestName: string;
  property: string;
  code: string;
  checkIn: string;
  checkOut: string;
  amount: string;
}): Promise<void> {
  return sendWhatsApp({
    campaignName: env.whatsapp.campaigns.bookingGuest,
    destination: o.phone,
    userName: o.guestName,
    templateParams: [o.guestName, o.property, o.code, o.checkIn, o.checkOut, o.amount],
  });
}

/**
 * New booking → partner. Utility template. Param order:
 *   {{1}} property     {{2}} booking code  {{3}} guest name
 *   {{4}} check-in     {{5}} check-out     {{6}} rooms       {{7}} payout
 */
export function sendWhatsAppBookingPartner(o: {
  phone: string;
  property: string;
  code: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  rooms: string;
  payout: string;
}): Promise<void> {
  return sendWhatsApp({
    campaignName: env.whatsapp.campaigns.bookingPartner,
    destination: o.phone,
    templateParams: [o.property, o.code, o.guestName, o.checkIn, o.checkOut, o.rooms, o.payout],
  });
}

/**
 * Booking cancelled → guest. Utility template. Param order:
 *   {{1}} guest name   {{2}} booking code  {{3}} property   {{4}} refund line
 */
export function sendWhatsAppCancelledGuest(o: {
  phone: string;
  guestName: string;
  code: string;
  property: string;
  refundLine: string;
}): Promise<void> {
  return sendWhatsApp({
    campaignName: env.whatsapp.campaigns.bookingCancelledGuest,
    destination: o.phone,
    userName: o.guestName,
    templateParams: [o.guestName, o.code, o.property, o.refundLine],
  });
}

/**
 * Booking cancelled → partner. Utility template. Param order:
 *   {{1}} booking code  {{2}} guest name  {{3}} property  {{4}} check-in  {{5}} check-out
 */
export function sendWhatsAppCancelledPartner(o: {
  phone: string;
  code: string;
  guestName: string;
  property: string;
  checkIn: string;
  checkOut: string;
}): Promise<void> {
  return sendWhatsApp({
    campaignName: env.whatsapp.campaigns.bookingCancelledPartner,
    destination: o.phone,
    templateParams: [o.code, o.guestName, o.property, o.checkIn, o.checkOut],
  });
}
