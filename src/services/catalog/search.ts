// Property search for the guest website (/public/search).
// Without dates: LIVE properties filtered by city/area/type/tags/amenities/rating/price (startingPrice).
// With dates: additionally only properties that have ≥ `rooms` sellable rooms of some ACTIVE room type
// (fitting the party) on every night, and whose cheapest bookable rate plan average is used as the price.
// Missing inventory rows default to roomType.totalRooms; missing rates rows to ratePlan.basePrice.
import { inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { getRankingSettings } from "../settings";
import { properties } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { diffDays, todayIST } from "../../lib/utils";
import { buildPropertyCards } from "./cards";
import { PROPERTY_TYPES, TRAVEL_TAGS } from "./dto";

export type SearchParams = {
  q?: string;
  city?: string;
  area?: string;
  types: string[];
  tags: string[];
  amenities: string[];
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  rooms?: number;
  minPrice?: number;
  maxPrice?: number;
  rating?: number;
  sort?: string;
  page: number;
  limit: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** SQL (CTE) returning (property_id, min_total) for properties bookable for the given stay. */
export function availabilityCte(p: {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  propertyFilter?: SQL;
}) {
  const nights = diffDays(p.checkIn, p.checkOut);
  return sql`
    nights AS (
      SELECT generate_series(${p.checkIn}::date, ${p.checkOut}::date - 1, interval '1 day')::date AS d
    ),
    rt AS (
      SELECT rt.id, rt.property_id, rt.total_rooms
      FROM room_types rt JOIN properties pp ON pp.id = rt.property_id
      WHERE pp.status = 'LIVE' AND rt.status = 'ACTIVE'
        AND rt.max_adults * ${p.rooms} >= ${p.adults}
        AND rt.max_occupancy * ${p.rooms} >= ${p.adults + p.children}
        ${p.propertyFilter ? sql`AND ${p.propertyFilter}` : sql``}
    ),
    rt_ok AS (
      SELECT rt.id, rt.property_id
      FROM rt CROSS JOIN nights n
      LEFT JOIN inventory i ON i.room_type_id = rt.id AND i.date = n.d
      GROUP BY rt.id, rt.property_id
      HAVING bool_and(
        NOT coalesce(i.stop_sell, false)
        AND coalesce(i.total, rt.total_rooms) - coalesce(i.sold, 0) - coalesce(i.held, 0) - coalesce(i.blocked, 0) >= ${p.rooms}
      )
    ),
    plan_ok AS (
      SELECT rt_ok.property_id, rp.id, sum(coalesce(r.price, rp.base_price)) AS total
      FROM rt_ok
      JOIN rate_plans rp ON rp.room_type_id = rt_ok.id AND rp.is_active
      CROSS JOIN nights n
      LEFT JOIN rates r ON r.rate_plan_id = rp.id AND r.date = n.d
      WHERE NOT EXISTS (
        SELECT 1 FROM rates rd WHERE rd.rate_plan_id = rp.id AND rd.date = ${p.checkOut}::date AND rd.closed_to_departure
      )
      GROUP BY rt_ok.property_id, rp.id
      HAVING bool_and(NOT coalesce(r.stop_sell, false))
        AND NOT bool_or(n.d = ${p.checkIn}::date AND coalesce(r.closed_to_arrival, false))
        AND coalesce(max(r.min_stay) FILTER (WHERE n.d = ${p.checkIn}::date), 1) <= ${nights}
        AND coalesce(min(r.max_stay) FILTER (WHERE n.d = ${p.checkIn}::date), 100000) >= ${nights}
    ),
    avail AS (
      SELECT property_id, min(total) AS min_total FROM plan_ok GROUP BY property_id
    )`;
}

export async function searchProperties(params: SearchParams) {
  const filters: SQL[] = [sql`p.status = 'LIVE'`];
  const q = params.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    filters.push(
      sql`(p.name ILIKE ${like} OR c.name ILIKE ${like} OR ar.name ILIKE ${like} OR p.short_description ILIKE ${like} OR c.state ILIKE ${like})`,
    );
  }
  if (params.city) filters.push(sql`c.slug = ${params.city}`);
  if (params.area) filters.push(sql`ar.slug = ${params.area}`);
  const types = params.types.map((t) => t.toUpperCase()).filter((t) => (PROPERTY_TYPES as string[]).includes(t));
  if (types.length) filters.push(sql`p.type::text IN ${types}`);
  const tags = params.tags.map((t) => t.toUpperCase()).filter((t) => (TRAVEL_TAGS as string[]).includes(t));
  if (tags.length) filters.push(sql`p.travel_tags::text[] && ${sql.raw(`ARRAY[${tags.map((t) => `'${t}'`).join(",")}]`)}::text[]`);
  if (params.amenities.length) {
    const codes = [...new Set(params.amenities)];
    filters.push(sql`(
      SELECT count(DISTINCT a.code) FROM property_amenities pa JOIN amenities a ON a.id = pa.amenity_id
      WHERE pa.property_id = p.id AND a.code IN ${codes}
    ) = ${codes.length}`);
  }
  if (params.rating) filters.push(sql`p.rating_avg >= ${params.rating}`);

  const rooms = Math.max(1, params.rooms ?? 1);
  const adults = Math.max(1, params.adults ?? 1);
  const children = Math.max(0, params.children ?? 0);

  let withDates = false;
  let nights = 0;
  if (params.checkIn || params.checkOut) {
    if (!params.checkIn || !params.checkOut || !DATE_RE.test(params.checkIn) || !DATE_RE.test(params.checkOut))
      throw badRequest("Please choose valid check-in and check-out dates");
    nights = diffDays(params.checkIn, params.checkOut);
    if (nights < 1) throw badRequest("Check-out must be after check-in");
    if (nights > 60) throw badRequest("Stays longer than 60 nights cannot be searched");
    if (params.checkIn < todayIST()) throw badRequest("Check-in date is in the past");
    withDates = true;
  } else if (params.adults || params.children || params.rooms) {
    // No dates: still hide properties that cannot host the party at all.
    filters.push(sql`EXISTS (
      SELECT 1 FROM room_types rt WHERE rt.property_id = p.id AND rt.status = 'ACTIVE'
        AND rt.max_adults * ${rooms} >= ${adults} AND rt.max_occupancy * ${rooms} >= ${adults + children}
    )`);
  }

  const priceExpr = withDates ? sql`round(av.min_total::numeric / ${nights})::bigint` : sql`p.starting_price`;
  if (params.minPrice != null) filters.push(sql`${priceExpr} >= ${params.minPrice}`);
  if (params.maxPrice != null) filters.push(sql`${priceExpr} <= ${params.maxPrice}`);

  const { mode } = await getRankingSettings();
  const orderBy = (() => {
    switch (params.sort) {
      case "price_asc":
        return sql`price ASC NULLS LAST, p.rating_avg DESC`;
      case "price_desc":
        return sql`price DESC NULLS LAST, p.rating_avg DESC`;
      case "rating":
        return sql`p.rating_avg DESC, p.rating_count DESC`;
      case "newest":
        return sql`coalesce(p.published_at, p.created_at) DESC`;
      case "popular":
        return sql`p.popularity_score DESC, p.completed_bookings DESC, p.rating_avg DESC`;
      default:
        return mode === "PINS_FIRST"
          ? sql`p.is_recommended DESC, p.is_featured DESC, p.curation_rank DESC, p.popularity_score DESC, p.rating_avg DESC, p.rating_count DESC`
          : // most-booked stays first; the admin's rank breaks ties
            sql`p.popularity_score DESC, p.completed_bookings DESC, p.curation_rank DESC, p.rating_avg DESC, p.rating_count DESC`;
    }
  })();

  const cte = withDates
    ? sql`WITH ${availabilityCte({ checkIn: params.checkIn!, checkOut: params.checkOut!, adults, children, rooms })}`
    : sql``;
  const from = sql`
    FROM properties p
    LEFT JOIN cities c ON c.id = p.city_id
    LEFT JOIN areas ar ON ar.id = p.area_id
    ${withDates ? sql`JOIN avail av ON av.property_id = p.id` : sql``}
    WHERE ${sql.join(filters, sql` AND `)}`;

  const [pageRows, facetRows] = await Promise.all([
    db.execute<{ id: string; price: string | null; total: number }>(sql`
      ${cte}
      SELECT p.id, ${priceExpr} AS price, count(*) OVER ()::int AS total
      ${from}
      ORDER BY ${orderBy}, p.id
      LIMIT ${params.limit} OFFSET ${(params.page - 1) * params.limit}
    `),
    db.execute<{ type: string; n: number; min_price: string | null; max_price: string | null }>(sql`
      ${cte}
      SELECT p.type::text AS type, count(*)::int AS n, min(${priceExpr}) AS min_price, max(${priceExpr}) AS max_price
      ${from}
      GROUP BY p.type
    `),
  ]);

  const list = [...pageRows];
  const total = list[0]?.total ?? (params.page > 1 ? sumFacet(facetRows) : 0);
  const priceOverride = withDates
    ? new Map(list.filter((r) => r.price != null).map((r) => [r.id, Number(r.price)]))
    : undefined;
  let items: Awaited<ReturnType<typeof buildPropertyCards>> = [];
  if (list.length) {
    const rows = await db.select().from(properties).where(inArray(properties.id, list.map((r) => r.id)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    items = await buildPropertyCards(
      list.map((r) => byId.get(r.id)!).filter(Boolean),
      priceOverride,
    );
  }

  const facetList = [...facetRows];
  const prices = facetList.flatMap((f) => [f.min_price, f.max_price]).filter((x): x is string => x != null).map(Number);
  const facets = {
    types: Object.fromEntries(PROPERTY_TYPES.map((t) => [t, facetList.find((f) => f.type === t)?.n ?? 0])),
    priceRange: { min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null },
    nights: withDates ? nights : null,
  };
  return {
    items,
    total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.ceil(total / params.limit),
    facets,
  };
}

const sumFacet = (rows: Iterable<{ n: number }>) => {
  let s = 0;
  for (const r of rows) s += r.n;
  return s;
};
