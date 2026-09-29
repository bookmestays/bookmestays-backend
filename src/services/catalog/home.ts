// Resolves /public/home: active banners + each active home section resolved per its type.
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { areas, banners, cities, collections, experiences, homeSections, properties } from "../../db/schema";
import {
  activeCollectionCards,
  activeExperienceCards,
  buildCityCards,
  cityOrder,
  livePropertyCards,
  propertyCardsByIds,
  videoFeed,
} from "./cards";
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES, toArea } from "./dto";

type SectionRow = typeof homeSections.$inferSelect;

const num = (v: unknown, fallback: number, max = 50) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};
const strArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function resolveCityId(config: Record<string, unknown>) {
  if (typeof config.cityId === "string") return config.cityId;
  if (typeof config.citySlug === "string") {
    const c = await db.query.cities.findFirst({ where: eq(cities.slug, config.citySlug) });
    return c?.id ?? null;
  }
  return null;
}

export async function activeBanners() {
  const now = new Date();
  const rows = await db
    .select({ banner: banners, propertySlug: properties.slug, propertyStatus: properties.status })
    .from(banners)
    .leftJoin(properties, eq(properties.id, banners.propertyId))
    .where(
      and(
        eq(banners.isActive, true),
        or(isNull(banners.startsAt), lte(banners.startsAt, now)),
        or(isNull(banners.endsAt), gt(banners.endsAt, now)),
      ),
    )
    .orderBy(asc(banners.sort), desc(banners.createdAt));
  return rows.map(({ banner: b, propertySlug, propertyStatus }) => ({
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    videoUrl: b.videoUrl,
    hlsUrl: b.hlsUrl,
    posterUrl: b.posterUrl,
    ctaLabel: b.ctaLabel,
    ctaUrl: b.ctaUrl,
    propertySlug: propertyStatus === "LIVE" ? (propertySlug ?? null) : null,
  }));
}

export async function propertyTypeTiles(cityId?: string | null, images?: Record<string, unknown>) {
  const rows = await db.execute<{ type: string; n: number; image: string | null }>(sql`
    SELECT p.type::text AS type, count(*)::int AS n,
      (array_agg(p.cover_image_url ORDER BY p.is_featured DESC, p.curation_rank DESC, p.rating_avg DESC)
         FILTER (WHERE p.cover_image_url IS NOT NULL))[1] AS image
    FROM properties p
    WHERE p.status = 'LIVE' ${cityId ? sql`AND p.city_id = ${cityId}` : sql``}
    GROUP BY p.type
  `);
  const map = new Map([...rows].map((r) => [r.type, r]));
  return PROPERTY_TYPES.map((type) => ({
    type,
    label: PROPERTY_TYPE_LABELS[type],
    count: map.get(type)?.n ?? 0,
    imageUrl: (typeof images?.[type] === "string" ? (images[type] as string) : null) ?? map.get(type)?.image ?? null,
  }));
}

async function resolveSection(s: SectionRow) {
  const config = (s.config ?? {}) as Record<string, unknown>;
  const base = { id: s.id, title: s.title, subtitle: s.subtitle };
  const limit = num(config.limit, 10);
  switch (s.type) {
    case "RECOMMENDED":
    case "FEATURED": {
      const ids = strArray(config.propertyIds);
      const cityId = await resolveCityId(config);
      const items = ids.length
        ? await propertyCardsByIds(ids.slice(0, limit))
        : await livePropertyCards(
            and(
              s.type === "FEATURED" ? eq(properties.isFeatured, true) : eq(properties.isRecommended, true),
              cityId ? eq(properties.cityId, cityId) : undefined,
            ),
            limit,
          );
      return { ...base, type: s.type, items };
    }
    case "PROPERTY_TYPES": {
      const cityId = await resolveCityId(config);
      const images = (config.images ?? {}) as Record<string, unknown>;
      return { ...base, type: s.type, items: await propertyTypeTiles(cityId, images) };
    }
    case "VIDEO_DISCOVERY": {
      const cityId = await resolveCityId(config);
      return {
        ...base,
        type: s.type,
        items: await videoFeed({ cityId: cityId ?? undefined, limit: num(config.limit, 12) }),
      };
    }
    case "EXPERIENCES": {
      const cityId = await resolveCityId(config);
      const items = await activeExperienceCards(cityId ? eq(experiences.cityId, cityId) : undefined, num(config.limit, 8));
      return { ...base, type: s.type, items };
    }
    case "CITIES": {
      const ids = strArray(config.cityIds);
      const rows = await db
        .select()
        .from(cities)
        .where(and(eq(cities.isActive, true), ids.length ? inArray(cities.id, ids) : undefined))
        .orderBy(...cityOrder)
        .limit(num(config.limit, 12));
      return { ...base, type: s.type, items: await buildCityCards(rows) };
    }
    case "COLLECTIONS": {
      const cityId = await resolveCityId(config);
      const items = await activeCollectionCards(cityId ? eq(collections.cityId, cityId) : undefined, num(config.limit, 6));
      return { ...base, type: s.type, items };
    }
    case "CITY_SPOTLIGHT": {
      const cityId = await resolveCityId(config);
      const city = cityId
        ? await db.query.cities.findFirst({ where: and(eq(cities.id, cityId), eq(cities.isActive, true)) })
        : undefined;
      if (!city) return { ...base, type: s.type, city: null, areas: [], items: [], experiences: [] };
      const [[cityCard], areaRows, items, exps] = await Promise.all([
        buildCityCards([city]),
        db.select().from(areas).where(eq(areas.cityId, city.id)).orderBy(desc(areas.isRecommended), asc(areas.name)),
        livePropertyCards(eq(properties.cityId, city.id), num(config.limit, 8)),
        activeExperienceCards(eq(experiences.cityId, city.id), 6),
      ]);
      return { ...base, type: s.type, city: cityCard, areas: areaRows.map(toArea), items, experiences: exps };
    }
    case "WHY_BOOKMESTAYS":
    default:
      return { ...base, type: s.type, items: [] as [] };
  }
}

export async function homePayload() {
  const sectionRows = await db
    .select()
    .from(homeSections)
    .where(eq(homeSections.isActive, true))
    .orderBy(asc(homeSections.sort));
  const [bannerList, sections] = await Promise.all([activeBanners(), Promise.all(sectionRows.map(resolveSection))]);
  return { banners: bannerList, sections };
}

