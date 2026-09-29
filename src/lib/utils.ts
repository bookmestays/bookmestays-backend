import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

// ─── Money (paise) ────────────────────────────────────────────────────────────

export const rupeesToPaise = (rupees: number) => Math.round(rupees * 100);
export const paiseToRupees = (paise: number) => paise / 100;
/** Percentage of an amount where rate is in basis points (1500 = 15%). Rounded to paise. */
export const applyBps = (amount: number, bps: number) => Math.round((amount * bps) / 10_000);

// ─── Dates (YYYY-MM-DD strings, no timezone surprises) ────────────────────────

export const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
export const parseDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, days: number) => {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateStr(d);
};
export const diffDays = (from: string, to: string) =>
  Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
/** Every night between check-in (inclusive) and check-out (exclusive). */
export const nightsBetween = (checkIn: string, checkOut: string) => {
  const out: string[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
};
/** Today in India (IST) as YYYY-MM-DD. */
export const todayIST = () => toDateStr(new Date(Date.now() + 5.5 * 3600_000));

// ─── Strings ──────────────────────────────────────────────────────────────────

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const randomCode = (len: number) => {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
};
export const bookingCode = () => `BMS${randomCode(7)}`;
export const randomPassword = () => `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ─── Encryption at rest (AES-256-GCM) for bank numbers, CM credentials ───────

const key = () => createHash("sha256").update(env.encryptionKey).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export const pageParams = (q: { page?: string | number; limit?: string | number }) => {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
};
export const paginated = <T>(items: T[], total: number, page: number, limit: number) => ({
  items,
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
});
