import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";

// Email sender (nodemailer over SMTP). Provider is chosen by env; "console" just logs (development).

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
    secure: env.email.smtpPort === 465,
    auth: { user: env.email.smtpUser, pass: env.email.smtpPass },
  });
  await transporter.sendMail({ from: env.email.from, ...mail });
}

/** Fire-and-forget wrapper so notification failures never break a request. */
export const notifyLater = (p: Promise<unknown>) =>
  p.catch((err) => console.error("Notification failed:", err));
