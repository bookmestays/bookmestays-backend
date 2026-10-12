// Performance tiers: properties that receive enough real bookings in a trailing
// window earn the admin-configured "Gold" and/or "Rising" badges automatically.
//
//   isGold   = gold.enabled   AND (bookings in last gold.windowDays)   >= gold.minBookings
//   isRising = rising.enabled AND (bookings in last rising.windowDays) >= rising.minBookings
//
// A "booking" here is one that actually happened — CONFIRMED, CHECKED_IN or COMPLETED —
// counted by when it was created, so a hotel can earn the badge within days of a good run.
// The two tiers are independent: a property can hold both.
//
// Flags are denormalised onto `properties` so the homepage rows stay a single fast query.
// Recomputed hourly (safety net), whenever the admin edits the targets, and when a booking confirms.
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getTierSettings } from "../settings";

/**
 * Recomputes the Gold / Rising flags. Pass property ids to refresh just those,
 * or nothing to refresh every property (hourly job / after a settings change).
 * Returns the number of rows whose tier actually changed.
 */
export async function recalcTiers(propertyIds?: string[]): Promise<number> {
  if (propertyIds && propertyIds.length === 0) return 0;
  const { gold, rising } = await getTierSettings();
  const goldDays = Math.max(1, Math.floor(gold.windowDays || 7));
  const risingDays = Math.max(1, Math.floor(rising.windowDays || 7));
  const idList = propertyIds?.length ? sql.join(propertyIds.map((id) => sql`${id}::uuid`), sql`, `) : null;
  const scope = idList ? sql`WHERE p2.id IN (${idList})` : sql``;
  const onlyThese = idList ? sql`AND p.id IN (${idList})` : sql``;

  // The booked-count expressions, reused in SET and in the change-detection guard.
  const goldFlag = sql`(${gold.enabled}::bool AND c.gcnt >= ${gold.minBookings})`;
  const risingFlag = sql`(${rising.enabled}::bool AND c.rcnt >= ${rising.minBookings})`;

  const rows = await db.execute<{ id: string }>(sql`
    UPDATE properties p SET
      is_gold = ${goldFlag},
      is_rising = ${risingFlag},
      tier_updated_at = now()
    FROM (
      SELECT p2.id,
        count(b.id) FILTER (
          WHERE b.status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETED')
            AND b.created_at >= now() - (${goldDays} * interval '1 day')
        )::int AS gcnt,
        count(b.id) FILTER (
          WHERE b.status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETED')
            AND b.created_at >= now() - (${risingDays} * interval '1 day')
        )::int AS rcnt
      FROM properties p2
      LEFT JOIN bookings b ON b.property_id = p2.id
      ${scope}
      GROUP BY p2.id
    ) c
    WHERE c.id = p.id
      AND (p.is_gold, p.is_rising) IS DISTINCT FROM (${goldFlag}, ${risingFlag})
      ${onlyThese}
    RETURNING p.id
  `);
  return rows.length;
}

/** Fire-and-forget refresh after a booking changes state; never breaks the caller. */
export function refreshTiersFor(propertyId: string | null | undefined) {
  if (!propertyId) return;
  void recalcTiers([propertyId]).catch((err) => console.error("tier refresh failed", err));
}
