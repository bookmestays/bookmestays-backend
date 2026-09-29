// Popularity ranking: properties that guests actually book rise to the top of the
// "Recommended" ordering on the homepage, category pages and search.
//
//   score = completed stays − CANCELLATION_PENALTY × cancelled bookings
//
// e.g. 6 completed / 0 cancelled (6.0) ranks above 5 completed / 1 cancelled (4.5),
// which ranks above 3 completed / 0 cancelled (3.0).
//
// Counts are denormalised onto `properties` so listings stay a single fast query.
// They are refreshed when a stay completes or a booking is cancelled, and hourly as a safety net.
import { sql } from "drizzle-orm";
import { db } from "../../db";

/** How much one cancellation cancels out (0.5 = half a completed stay). */
export const CANCELLATION_PENALTY = 0.5;

/**
 * Recomputes booking counts + popularity score. Pass property ids to refresh just those,
 * or nothing to refresh every property (hourly job / backfill).
 */
export async function recalcPopularity(propertyIds?: string[]): Promise<number> {
  if (propertyIds && propertyIds.length === 0) return 0;
  const idList = propertyIds?.length ? sql.join(propertyIds.map((id) => sql`${id}::uuid`), sql`, `) : null;
  const onlyThese = idList ? sql`AND p.id IN (${idList})` : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE properties p SET
      completed_bookings = c.completed,
      cancelled_bookings = c.cancelled,
      popularity_score = c.completed - ${CANCELLATION_PENALTY}::float8 * c.cancelled,
      popularity_updated_at = now()
    FROM (
      SELECT p2.id,
             count(*) FILTER (WHERE b.status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE b.status IN ('CANCELLED', 'NO_SHOW'))::int AS cancelled
      FROM properties p2
      LEFT JOIN bookings b ON b.property_id = p2.id
      ${idList ? sql`WHERE p2.id IN (${idList})` : sql``}
      GROUP BY p2.id
    ) c
    WHERE c.id = p.id
      AND (p.completed_bookings, p.cancelled_bookings) IS DISTINCT FROM (c.completed, c.cancelled)
      ${onlyThese}
    RETURNING p.id
  `);
  return rows.length;
}

/** Fire-and-forget refresh after a booking changes state; never breaks the caller. */
export function refreshPopularityFor(propertyId: string | null | undefined) {
  if (!propertyId) return;
  void recalcPopularity([propertyId]).catch((err) => console.error("popularity refresh failed", err));
}
