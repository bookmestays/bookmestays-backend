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
