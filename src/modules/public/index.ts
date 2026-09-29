import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import {
  amenities,
  analyticsEvents,
  areas,
  cities,
  collectionItems,
  collections,
  experiences,
  media,
  properties,
  reviews,
  siteSettings,
} from "../../db/schema";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { notFound } from "../../lib/errors";
import { pageParams, paginated } from "../../lib/utils";
import {
  activeCollectionCards,
  activeExperienceCards,
  buildCityCards,
  buildCollectionCards,
  buildExperienceCards,
  buildPropertyCards,
  cityOrder,
  curatedOrder,
  LIVE,
  livePropertyCards,
  videoFeed,
} from "../../services/catalog/cards";
import {
  PROPERTY_TYPE_LABELS,
  PROPERTY_TYPES,
  toAmenity,
  toArea,
  toCityLite,
  toMedia,
  TRAVEL_TAG_LABELS,
  TRAVEL_TAGS,
} from "../../services/catalog/dto";
import { homePayload } from "../../services/catalog/home";
import { buildReviews, publicPropertyDetail } from "../../services/catalog/property-detail";
import { searchProperties } from "../../services/catalog/search";

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

// ─── /public/meta (cached 5 min in memory) ────────────────────────────────────
let metaCache: { at: number; value: unknown } | null = null;
async function siteMeta() {
  if (metaCache && Date.now() - metaCache.at < 5 * 60_000) return metaCache.value;
  const [cityRows, amenityRows, support] = await Promise.all([
    db.select().from(cities).where(eq(cities.isActive, true)).orderBy(asc(cities.sort), asc(cities.name)),
    db.select().from(amenities).orderBy(asc(amenities.sort), asc(amenities.name)),
    db.query.siteSettings.findFirst({ where: eq(siteSettings.key, "support") }),
  ]);
  const s = (support?.value ?? {}) as Record<string, unknown>;
  const value = {
    cities: cityRows.map(toCityLite),
    propertyTypes: PROPERTY_TYPES.map((v) => ({ value: v, label: PROPERTY_TYPE_LABELS[v] })),
    travelTags: TRAVEL_TAGS.map((v) => ({ value: v, label: TRAVEL_TAG_LABELS[v] })),
    amenities: amenityRows.map(toAmenity),
    support: {
      phone: String(s.phone ?? ""),
      email: String(s.email ?? ""),
      whatsapp: String(s.whatsapp ?? ""),
      social: (s.social && typeof s.social === "object" ? s.social : {}) as Record<string, string>,
    },
  };
  metaCache = { at: Date.now(), value };
  return value;
}
let homeCache: { at: number; value: ReturnType<typeof homePayload> } | null = null;
export const invalidateMetaCache = () => {
  metaCache = null;
  homeCache = null;
};

async function cityBySlug(slug: string) {
  const c = await db.query.cities.findFirst({ where: and(eq(cities.slug, slug), eq(cities.isActive, true)) });
  if (!c) throw notFound("City");
  return c;
}

async function livePropertyBySlug(slug: string) {
  const p = await db.query.properties.findFirst({ where: and(eq(properties.slug, slug), LIVE) });
  if (!p) throw notFound("Property");
  return p;
}

const listParam = (url: string, name: string) =>
  new URL(url).searchParams
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
const optNum = (v: string | undefined) => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

export const publicModule = new Elysia({ prefix: "/public", tags: ["Public"] })
  .use(authPlugin)

  .get("/meta", async ({ set }) => {
    set.headers["cache-control"] = "public, max-age=300";
    return siteMeta();
  })

  // Short-lived shared cache (also de-duplicates concurrent cold requests).
  .get("/home", ({ set }) => {
    set.headers["cache-control"] = "public, max-age=30";
    if (!homeCache || Date.now() - homeCache.at > 30_000) {
      const value = homePayload();
      homeCache = { at: Date.now(), value };
      value.catch(() => (homeCache = null));
    }
    return homeCache.value;
  })

  .get(
    "/suggest",
    async ({ query }) => {
      const q = query.q?.trim() ?? "";
      if (q.length < 1) return { cities: [], areas: [], properties: [] };
      const like = `%${escapeLike(q)}%`;
      const [cityRows, areaRows, propRows] = await Promise.all([
        db
          .select()
          .from(cities)
          .where(and(eq(cities.isActive, true), or(ilike(cities.name, like), ilike(cities.state, like))))
          .orderBy(...cityOrder)
          .limit(5),
        db
          .select({ id: areas.id, name: areas.name, slug: areas.slug, citySlug: cities.slug, cityName: cities.name })
          .from(areas)
          .innerJoin(cities, eq(cities.id, areas.cityId))
          .where(and(eq(cities.isActive, true), ilike(areas.name, like)))
          .orderBy(desc(areas.isRecommended), asc(areas.name))
          .limit(5),
        db
          .select({ id: properties.id, name: properties.name, slug: properties.slug, cityName: cities.name, type: properties.type })
          .from(properties)
          .leftJoin(cities, eq(cities.id, properties.cityId))
          .where(and(LIVE, ilike(properties.name, like)))
          .orderBy(...(await curatedOrder()))
          .limit(6),
      ]);
      return { cities: cityRows.map(toCityLite), areas: areaRows, properties: propRows };
    },
    { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })) }) },
  )

  .get("/search", async ({ query, request }) => {
    const q = query as Record<string, string | undefined>;
    const { page, limit } = pageParams(q);
    return searchProperties({
      q: q.q,
      city: q.city || undefined,
      area: q.area || undefined,
      types: listParam(request.url, "type"),
      tags: listParam(request.url, "tags"),
      amenities: listParam(request.url, "amenities"),
      checkIn: q.checkIn || undefined,
      checkOut: q.checkOut || undefined,
      adults: optNum(q.adults),
      children: optNum(q.children),
      rooms: optNum(q.rooms),
      minPrice: optNum(q.minPrice),
      maxPrice: optNum(q.maxPrice),
      rating: optNum(q.rating),
      sort: q.sort,
      page,
      limit,
    });
  })

  .get(
    "/properties/:slug",
    async ({ params, query, user }) => {
      const p = await db.query.properties.findFirst({ where: eq(properties.slug, params.slug) });
      const canPreview =
        query.preview === "1" &&
        !!user &&
        !!p &&
        (ADMIN_ROLES.includes(user.role) || (user.partnerId != null && user.partnerId === p.partnerId));
      if (!p || (p.status !== "LIVE" && !canPreview)) throw notFound("Property");
      return publicPropertyDetail(p);
    },
    { query: t.Object({ preview: t.Optional(t.String()) }) },
  )

  .get(
    "/properties/:slug/reviews",
    async ({ params, query }) => {
      const p = await livePropertyBySlug(params.slug);
      const { page, limit, offset } = pageParams(query);
      const where = and(eq(reviews.propertyId, p.id), eq(reviews.status, "PUBLISHED"));
      const [rows, [{ n }]] = await Promise.all([
        db.select().from(reviews).where(where).orderBy(desc(reviews.createdAt)).limit(limit).offset(offset),
        db.select({ n: count() }).from(reviews).where(where),
      ]);
      return paginated(await buildReviews(rows), n, page, limit);
    },
    { query: t.Object({ page: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
  )

  .get("/properties/:slug/similar", async ({ params }) => {
    const p = await livePropertyBySlug(params.slug);
    const rows = await db
      .select()
      .from(properties)
      .where(
        and(
          LIVE,
          ne(properties.id, p.id),
          p.cityId ? or(eq(properties.cityId, p.cityId), eq(properties.type, p.type)) : eq(properties.type, p.type),
        ),
      )
      .orderBy(
        sql`(${properties.cityId} IS NOT DISTINCT FROM ${p.cityId} AND ${properties.type} = ${p.type}) DESC`,
        sql`(${properties.cityId} IS NOT DISTINCT FROM ${p.cityId}) DESC`,
        ...(await curatedOrder()),
      )
      .limit(8);
    return buildPropertyCards(rows);
  })

  .get(
    "/videos",
    async ({ query }) => {
      const cityId = query.city ? (await cityBySlug(query.city)).id : undefined;
      const type = query.type && (PROPERTY_TYPES as string[]).includes(query.type.toUpperCase()) ? query.type.toUpperCase() : undefined;
      return videoFeed({ cityId, type, limit: Math.min(50, Math.max(1, Number(query.limit) || 12)) });
    },
    { query: t.Object({ city: t.Optional(t.String()), type: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
  )

  .get("/cities", async () => {
    const rows = await db.select().from(cities).where(eq(cities.isActive, true)).orderBy(...cityOrder);
    return buildCityCards(rows);
  })

  .get("/cities/:slug", async ({ params }) => {
    const c = await cityBySlug(params.slug);
    const ranked = await db.execute<{ id: string; type: string; n: number }>(sql`
      SELECT id, type, n FROM (
        SELECT p.id, p.type::text AS type, count(*) OVER (PARTITION BY p.type)::int AS n,
          row_number() OVER (PARTITION BY p.type ORDER BY p.is_featured DESC, p.is_recommended DESC, p.curation_rank DESC, p.rating_avg DESC, p.name) AS rn
        FROM properties p WHERE p.status = 'LIVE' AND p.city_id = ${c.id}
      ) x WHERE rn <= 8
    `);
    const rankedList = [...ranked];
    const [[cityCard], areaRows, featured, typeRows, collectionCards, experienceCards, videos] = await Promise.all([
      buildCityCards([c]),
      db.select().from(areas).where(eq(areas.cityId, c.id)).orderBy(desc(areas.isRecommended), asc(areas.name)),
      livePropertyCards(eq(properties.cityId, c.id), 8),
      rankedList.length
        ? db.select().from(properties).where(inArray(properties.id, rankedList.map((r) => r.id))).orderBy(...(await curatedOrder()))
        : Promise.resolve([] as (typeof properties.$inferSelect)[]),
      activeCollectionCards(eq(collections.cityId, c.id), 12),
      activeExperienceCards(eq(experiences.cityId, c.id), 12),
      videoFeed({ cityId: c.id, limit: 12 }),
    ]);
    const cards = await buildPropertyCards(typeRows);
    const countByType = new Map(rankedList.map((r) => [r.type, r.n]));
    const byType = PROPERTY_TYPES.filter((type) => countByType.has(type)).map((type) => ({
      type,
      label: PROPERTY_TYPE_LABELS[type],
      count: countByType.get(type) ?? 0,
      items: cards.filter((card) => card.type === type),
    }));
    return {
      city: { ...cityCard, travelInfo: c.travelInfo, foodGuide: c.foodGuide, lat: c.lat, lng: c.lng, seo: c.seo ?? null },
      areas: areaRows.map(toArea),
      featured,
      byType,
      collections: collectionCards,
      experiences: experienceCards,
      videos,
    };
  })

  .get(
    "/experiences",
    async ({ query }) => {
      const { page, limit, offset } = pageParams(query);
      const cityId = query.city ? (await cityBySlug(query.city)).id : undefined;
      const where = and(eq(experiences.isActive, true), cityId ? eq(experiences.cityId, cityId) : undefined);
      const [rows, [{ n }]] = await Promise.all([
        db
          .select()
          .from(experiences)
          .where(where)
          .orderBy(asc(experiences.sort), desc(experiences.ratingAvg), asc(experiences.title))
          .limit(limit)
          .offset(offset),
        db.select({ n: count() }).from(experiences).where(where),
      ]);
      return paginated(await buildExperienceCards(rows), n, page, limit);
    },
    { query: t.Object({ city: t.Optional(t.String()), page: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
  )

  .get("/experiences/:slug", async ({ params }) => {
    const e = await db.query.experiences.findFirst({
      where: and(eq(experiences.slug, params.slug), eq(experiences.isActive, true)),
    });
    if (!e) throw notFound("Experience");
    const [[card], mediaRows, propertyCards, related] = await Promise.all([
      buildExperienceCards([e]),
      db
        .select()
        .from(media)
        .where(and(eq(media.ownerType, "EXPERIENCE"), eq(media.ownerId, e.id)))
        .orderBy(asc(media.sort), asc(media.createdAt)),
      e.propertyId ? livePropertyCards(eq(properties.id, e.propertyId), 1) : Promise.resolve([]),
      e.cityId
        ? livePropertyCards(
            and(eq(properties.cityId, e.cityId), e.propertyId ? ne(properties.id, e.propertyId) : undefined),
            8,
          )
        : Promise.resolve([]),
    ]);
    return {
      ...card,
      story: e.story,
      location: e.location,
      meetingPoint: e.meetingPoint,
      lat: e.lat,
      lng: e.lng,
      suitableFor: e.suitableFor,
      included: e.included,
      excluded: e.excluded,
      hostName: e.hostName,
      hostInfo: e.hostInfo,
      availabilityNote: e.availabilityNote,
      media: mediaRows.map(toMedia),
      property: propertyCards[0] ?? null,
      relatedStays: related,
      seo: e.seo ?? null,
    };
  })

  .get(
    "/collections",
    async ({ query }) => {
      const cityId = query.city ? (await cityBySlug(query.city)).id : undefined;
      return activeCollectionCards(cityId ? eq(collections.cityId, cityId) : undefined, 100);
    },
    { query: t.Object({ city: t.Optional(t.String()) }) },
  )

  .get("/collections/:slug", async ({ params }) => {
    const c = await db.query.collections.findFirst({
      where: and(eq(collections.slug, params.slug), eq(collections.isActive, true)),
    });
    if (!c) throw notFound("Collection");
    const rows = await db
      .select({ property: properties })
      .from(collectionItems)
      .innerJoin(properties, eq(properties.id, collectionItems.propertyId))
      .where(and(eq(collectionItems.collectionId, c.id), LIVE))
      .orderBy(asc(collectionItems.sort), ...(await curatedOrder()));
    const [[collection], cards] = await Promise.all([
      buildCollectionCards([c]),
      buildPropertyCards(rows.map((r) => r.property)),
    ]);
    return { collection, properties: cards };
  })

  .post(
    "/analytics",
    ({ body, user }) => {
      void db
        .insert(analyticsEvents)
        .values({
          name: body.name,
          sessionId: body.sessionId ?? null,
          userId: user?.id ?? null,
          props: body.props ?? null,
        })
        .catch((err) => console.error("analytics insert failed", err));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 80 }),
        sessionId: t.Optional(t.String({ maxLength: 80 })),
        props: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  );
