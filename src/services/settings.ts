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

export const getTaxSettings = () => getSetting("tax", DEFAULT_TAX);
export const getBookingSettings = () => getSetting("booking", DEFAULT_BOOKING);
export const getRankingSettings = () => getSetting("ranking", DEFAULT_RANKING);
