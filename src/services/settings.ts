import { eq } from "drizzle-orm";
import { db } from "../db";
import { siteSettings } from "../db/schema";

// Typed, briefly cached access to `site_settings` rows used by pricing / bookings.

export type TaxSettings = {
  roomGstSlabs: { upToPerNight: number | null; rateBps: number }[];
  commissionGstBps: number;
  tcsBps: number;
  tdsBps: number;
};
export type BookingSettings = { holdMinutes: number; maxRoomsPerBooking: number; maxNights: number };
/**
 * How stays are ordered in "Recommended" lists.
 *  MOST_BOOKED_FIRST — the stays guests actually book come first (admin rank breaks ties)
 *  PINS_FIRST        — the admin's manual order wins, popularity breaks ties
 */
export type RankingSettings = { mode: "MOST_BOOKED_FIRST" | "PINS_FIRST" };

/**
 * Auto-awarded performance tiers. A property earns a tier when it receives at least
 * `minBookings` real bookings (confirmed+) within the trailing `windowDays` days.
 * The two tiers are independent — a property can hold both.
 */
export type TierRule = { enabled: boolean; windowDays: number; minBookings: number };
export type TierSettings = { gold: TierRule; rising: TierRule };

/** Scrolling announcement shown as a marquee below the header on every public page. */
export type NoticeSettings = { enabled: boolean; text: string; speed: "slow" | "normal" | "fast" };

const DEFAULT_TAX: TaxSettings = {
  roomGstSlabs: [
    { upToPerNight: 750000, rateBps: 500 },
    { upToPerNight: null, rateBps: 1800 },
  ],
  commissionGstBps: 1800,
  tcsBps: 50,
  tdsBps: 10,
};
const DEFAULT_BOOKING: BookingSettings = { holdMinutes: 15, maxRoomsPerBooking: 5, maxNights: 30 };
const DEFAULT_RANKING: RankingSettings = { mode: "MOST_BOOKED_FIRST" };
const DEFAULT_TIERS: TierSettings = {
  gold: { enabled: true, windowDays: 7, minBookings: 12 },
  rising: { enabled: true, windowDays: 7, minBookings: 15 },
};
const DEFAULT_NOTICE: NoticeSettings = { enabled: false, text: "", speed: "normal" };

const TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; at: number }>();

async function getSetting<T extends object>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, key) });
  const value = { ...fallback, ...((row?.value as Partial<T>) ?? {}) } as T;
  cache.set(key, { value, at: Date.now() });
  return value;
}

/** Drop the cached value for a key (or all) so the next read reflects a just-saved change. */
export const invalidateSettingCache = (key?: string) => (key ? cache.delete(key) : cache.clear());

export const getTaxSettings = () => getSetting("tax", DEFAULT_TAX);
export const getBookingSettings = () => getSetting("booking", DEFAULT_BOOKING);
export const getRankingSettings = () => getSetting("ranking", DEFAULT_RANKING);
export const getTierSettings = () => getSetting("tiers", DEFAULT_TIERS);
export const getNoticeSettings = () => getSetting("notice", DEFAULT_NOTICE);
