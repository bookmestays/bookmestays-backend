import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";

// Email + SMS senders. Providers are chosen by env; "console" just logs (development).

type Email = { to: string; subject: string; html: string; text?: string };

let transporter: Transporter | null = null;

export async function sendEmail(mail: Email) {
  if (env.email.provider === "console" || !env.email.smtpHost) {
    console.log(`\n📧 [email:${mail.to}] ${mail.subject}\n${mail.text ?? mail.html}\n`);
    return;
  }
  transporter ??= nodemailer.createTransport({
    host: env.email.smtpHost,
    port: env.email.smtpPort,
    auth: { user: env.email.smtpUser, pass: env.email.smtpPass },
  });
  await transporter.sendMail({ from: env.email.from, ...mail });
}

export async function sendSms(phone: string, message: string, otp?: string) {
  if (env.sms.provider === "msg91" && env.sms.msg91AuthKey && otp) {
    const res = await fetch("https://control.msg91.com/api/v5/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: env.sms.msg91AuthKey },
      body: JSON.stringify({
        template_id: env.sms.msg91OtpTemplateId,
        mobile: phone.replace(/^\+/, ""),
        otp,
      }),
    });
    if (!res.ok) console.error("MSG91 error", await res.text());
    return;
  }
  console.log(`\n📱 [sms:${phone}] ${message}\n`);
}

/** Fire-and-forget wrapper so notification failures never break a request. */
export const notifyLater = (p: Promise<unknown>) =>
  p.catch((err) => console.error("Notification failed:", err));
