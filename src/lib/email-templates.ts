import { env } from "../config/env";

// Transactional email HTML. Table layout + inline styles so it renders the same in Gmail, Outlook and mobile clients.

const BRAND = "#225684";
const BRAND_SOFT = "#eaf1f8";
const INK = "#1f2937";
const MUTED = "#6b7280";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Wraps body HTML in the BookMeStays header/footer shell. `preheader` is the inbox preview line. */
export function emailLayout({ preheader, body }: { preheader: string; body: string }) {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>BookMeStays</title>
</head>
<body style="margin:0;padding:0;background:#f3f5f8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f8;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:${BRAND};padding:22px 32px;">
            <a href="${env.webUrl}" style="font-family:${FONT};font-size:22px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.2px;">BookMeStays</a>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;font-family:${FONT};color:${INK};font-size:15px;line-height:1.6;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
            This is an automated message from BookMeStays. Please do not reply to this email.<br>
            &copy; ${year} BookMeStays &middot; <a href="${env.webUrl}" style="color:${MUTED};">${env.webUrl.replace(/^https?:\/\//, "")}</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function otpEmail({ code, minutes }: { code: string; minutes: number }) {
  const subject = `${code} is your BookMeStays verification code`;
  const text = [
    "Your BookMeStays verification code",
    "",
    `Code: ${code}`,
    "",
    `Enter this code to sign in. It expires in ${minutes} minutes.`,
    "For your security, never share this code with anyone. BookMeStays will never ask you for it.",
    "",
    "If you didn't request this code, you can safely ignore this email.",
    "",
    "— Team BookMeStays",
  ].join("\n");
  const html = emailLayout({
    preheader: `Your verification code is ${code}. It expires in ${minutes} minutes.`,
    body: `
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:${INK};">Verify your email</h1>
            <p style="margin:0 0 24px;">Use the code below to sign in to your BookMeStays account.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background:${BRAND_SOFT};border-radius:10px;padding:22px 16px;">
                  <div style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${BRAND};">${code}</div>
                  <div style="margin-top:8px;font-size:13px;color:${MUTED};">Expires in ${minutes} minutes</div>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 8px;font-size:14px;color:${MUTED};">For your security, never share this code with anyone. BookMeStays will never ask you for it by phone, chat or email.</p>
            <p style="margin:0 0 24px;font-size:14px;color:${MUTED};">If you didn't request this code, you can safely ignore this email.</p>
            <p style="margin:0;">Happy staying,<br><strong>Team BookMeStays</strong></p>`,
  });
  return { subject, text, html };
}

// ─── Shared building blocks for transactional emails ──────────────────────────

/** A clean two-column facts table (label → value), brand-styled. */
function detailsTable(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
    ${rows
      .map(
        ([label, value], i) => `<tr>
        <td style="padding:12px 16px;background:${i % 2 ? "#ffffff" : "#f9fafb"};border-bottom:1px solid #eef1f5;font-size:13px;color:${MUTED};width:42%;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:12px 16px;background:${i % 2 ? "#ffffff" : "#f9fafb"};border-bottom:1px solid #eef1f5;font-size:14px;color:${INK};font-weight:600;">${escapeHtml(value)}</td>
      </tr>`,
      )
      .join("")}
  </table>`;
}

/** A brand-coloured call-to-action button. */
function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
    <tr><td align="center" style="background:${BRAND};border-radius:8px;">
      <a href="${url}" style="display:inline-block;padding:12px 28px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** A soft status banner (e.g. "Payment received", "Booking cancelled"). */
function statusBanner(text: string, tone: "success" | "neutral" = "success"): string {
  const bg = tone === "success" ? "#e7f6ec" : "#fdecec";
  const fg = tone === "success" ? "#1a7f44" : "#b4232a";
  return `<div style="display:inline-block;padding:6px 14px;border-radius:999px;background:${bg};color:${fg};font-size:13px;font-weight:700;margin-bottom:16px;">${escapeHtml(text)}</div>`;
}

export type BookingEmailData = {
  code: string;
  propertyName: string;
  guestName: string;
  guestPhone?: string | null;
  guestEmail?: string | null;
  stay: string; // "2026-11-20 → 2026-11-22 (2 nights)"
  checkInTime?: string;
  roomsText: string;
  guestsText: string; // "2 adult(s), 1 child(ren)"
  amount: string; // formatted, e.g. "₹7,400"
  payout?: string; // partner only
  settlementDueDate?: string; // partner only
  specialRequests?: string | null;
  manageUrl?: string; // guest only
  refundLine?: string; // cancellation
  cancelReason?: string | null; // cancellation (partner)
};

/** Booking confirmed → guest. Branded, same shell as every other BookMeStays email. */
export function bookingConfirmedGuestEmail(d: BookingEmailData) {
  const subject = `Booking confirmed — ${d.propertyName} (${d.code})`;
  const text = [
    `Hi ${d.guestName}, your stay at ${d.propertyName} is confirmed.`,
    `Booking code: ${d.code}`,
    `Stay: ${d.stay}${d.checkInTime ? `, check-in from ${d.checkInTime}` : ""}`,
    `Rooms: ${d.roomsText}`,
    `Guests: ${d.guestsText}`,
    `Amount paid: ${d.amount}`,
    d.manageUrl ? `Manage your booking: ${d.manageUrl}` : "",
    "",
    "— Team BookMeStays",
  ]
    .filter(Boolean)
    .join("\n");
  const html = emailLayout({
    preheader: `Your stay at ${d.propertyName} is confirmed — booking ${d.code}.`,
    body: `
            ${statusBanner("Booking confirmed")}
            <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">You're all set, ${escapeHtml(d.guestName.split(" ")[0] || d.guestName)}!</h1>
            <p style="margin:0 0 20px;">Your stay at <strong>${escapeHtml(d.propertyName)}</strong> is confirmed. Here are your details:</p>
            ${detailsTable([
              ["Booking code", d.code],
              ["Stay dates", d.stay],
              ...(d.checkInTime ? ([["Check-in from", d.checkInTime]] as [string, string][]) : []),
              ["Rooms", d.roomsText],
              ["Guests", d.guestsText],
              ["Amount paid", d.amount],
            ])}
            ${d.manageUrl ? ctaButton("View your booking", d.manageUrl) : ""}
            <p style="margin:20px 0 0;font-size:14px;color:${MUTED};">Need to make a change? Open your booking from your account or reply to the hotel's contact details in your confirmation.</p>
            <p style="margin:16px 0 0;">Happy staying,<br><strong>Team BookMeStays</strong></p>`,
  });
  return { subject, text, html };
}

/** New booking → partner. Same branded shell as the guest email (no more plain-text dumps). */
export function bookingConfirmedPartnerEmail(d: BookingEmailData) {
  const subject = `New booking ${d.code} — ${d.propertyName}`;
  const contact = [d.guestName, d.guestPhone, d.guestEmail].filter(Boolean).join(" · ");
  const text = [
    `New booking ${d.code} at ${d.propertyName}.`,
    `Guest: ${contact}`,
    `Stay: ${d.stay}`,
    `Rooms: ${d.roomsText}`,
    `Guests: ${d.guestsText}`,
    d.specialRequests ? `Special requests: ${d.specialRequests}` : "",
    d.payout ? `Prepaid online. Your payout: ${d.payout}${d.settlementDueDate ? ` (settles on/after ${d.settlementDueDate})` : ""}.` : "",
    "",
    "— Team BookMeStays",
  ]
    .filter(Boolean)
    .join("\n");
  const html = emailLayout({
    preheader: `New booking ${d.code} at ${d.propertyName} — ${d.stay}.`,
    body: `
            ${statusBanner("New booking")}
            <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">You've got a new booking</h1>
            <p style="margin:0 0 20px;">A guest just booked <strong>${escapeHtml(d.propertyName)}</strong>. Please confirm availability and prepare for their arrival.</p>
            ${detailsTable([
              ["Booking code", d.code],
              ["Guest", d.guestName],
              ...(d.guestPhone ? ([["Phone", d.guestPhone]] as [string, string][]) : []),
              ...(d.guestEmail ? ([["Email", d.guestEmail]] as [string, string][]) : []),
              ["Stay dates", d.stay],
              ["Rooms", d.roomsText],
              ["Guests", d.guestsText],
              ...(d.specialRequests ? ([["Special requests", d.specialRequests]] as [string, string][]) : []),
            ])}
            ${
              d.payout
                ? `<div style="margin:18px 0 0;padding:14px 16px;background:${BRAND_SOFT};border-radius:10px;font-size:14px;color:${INK};">
                     <strong>Prepaid online.</strong> Your payout is <strong>${escapeHtml(d.payout)}</strong>${
                       d.settlementDueDate ? `, settling on or after <strong>${escapeHtml(d.settlementDueDate)}</strong>` : ""
                     }.
                   </div>`
                : ""
            }
            <p style="margin:20px 0 0;">Thank you,<br><strong>Team BookMeStays</strong></p>`,
  });
  return { subject, text, html };
}

/** Booking cancelled → guest. */
export function bookingCancelledGuestEmail(d: BookingEmailData) {
  const subject = `Booking cancelled — ${d.code}`;
  const text = [
    `Hi ${d.guestName}, your booking ${d.code} at ${d.propertyName} (${d.stay}) has been cancelled.`,
    d.refundLine ?? "",
    "",
    "— Team BookMeStays",
  ]
    .filter(Boolean)
    .join("\n");
  const html = emailLayout({
    preheader: `Your booking ${d.code} at ${d.propertyName} has been cancelled.`,
    body: `
            ${statusBanner("Booking cancelled", "neutral")}
            <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">Your booking was cancelled</h1>
            <p style="margin:0 0 16px;">Hi ${escapeHtml(d.guestName)}, your booking at <strong>${escapeHtml(d.propertyName)}</strong> has been cancelled.</p>
            ${detailsTable([
              ["Booking code", d.code],
              ["Property", d.propertyName],
              ["Stay dates", d.stay],
            ])}
            ${d.refundLine ? `<p style="margin:18px 0 0;font-size:14px;color:${INK};">${escapeHtml(d.refundLine)}</p>` : ""}
            <p style="margin:18px 0 0;">We hope to host you another time,<br><strong>Team BookMeStays</strong></p>`,
  });
  return { subject, text, html };
}

/** Booking cancelled → partner. */
export function bookingCancelledPartnerEmail(d: BookingEmailData) {
  const subject = `Booking cancelled — ${d.code}`;
  const text = [
    `Booking ${d.code} (${d.guestName}, ${d.stay}) at ${d.propertyName} was cancelled${d.cancelReason ? `: ${d.cancelReason}` : ""}.`,
    "Inventory has been released.",
    "",
    "— Team BookMeStays",
  ].join("\n");
  const html = emailLayout({
    preheader: `Booking ${d.code} at ${d.propertyName} was cancelled.`,
    body: `
            ${statusBanner("Booking cancelled", "neutral")}
            <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">A booking was cancelled</h1>
            <p style="margin:0 0 16px;">The following booking at <strong>${escapeHtml(d.propertyName)}</strong> has been cancelled and its inventory released.</p>
            ${detailsTable([
              ["Booking code", d.code],
              ["Guest", d.guestName],
              ["Stay dates", d.stay],
              ...(d.cancelReason ? ([["Reason", d.cancelReason]] as [string, string][]) : []),
            ])}
            <p style="margin:18px 0 0;">Thank you,<br><strong>Team BookMeStays</strong></p>`,
  });
  return { subject, text, html };
}
