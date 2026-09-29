// Admin CMS: experiences, collections (+items), hero banners, home sections, amenities.
import { and, asc, count, desc, eq, ilike, inArray, ne } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import {
  amenities,
  banners,
  cities,
  collectionItems,
  collections,
  experiences,
  homeSections,
  properties,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { pageParams, paginated, slugify } from "../../lib/utils";
import { uniqueSlug } from "../../services/catalog/accounts";
import { buildCollectionCards, buildExperienceCards } from "../../services/catalog/cards";
import { groupBy, iso, toAmenity } from "../../services/catalog/dto";
import { invalidateMetaCache } from "../public";
import { defined, lit, money, nstr, pageQuery, seoSchema } from "./schemas";

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const strList = (max = 30) => t.Array(t.String({ maxLength: 300 }), { maxItems: max });

async function assertCity(cityId: string | null | undefined) {
  if (cityId && !(await db.query.cities.findFirst({ where: eq(cities.id, cityId) })))
    throw badRequest("Selected city does not exist");
}
async function assertProperty(propertyId: string | null | undefined) {
  if (propertyId && !(await db.query.properties.findFirst({ where: eq(properties.id, propertyId) })))
    throw badRequest("Selected property does not exist");
}

// ─── Experiences ──────────────────────────────────────────────────────────────

type ExperienceRow = typeof experiences.$inferSelect;

async function adminExperiences(rows: ExperienceRow[]) {
  const cards = await buildExperienceCards(rows);
  return rows.map((e, i) => ({
    ...cards[i],
    cityId: e.cityId,
    propertyId: e.propertyId,
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
    isActive: e.isActive,
    sort: e.sort,
    seo: e.seo ?? null,
    createdAt: iso(e.createdAt)!,
    updatedAt: iso(e.updatedAt)!,
  }));
}

const experienceFields = {
  title: t.String({ minLength: 2, maxLength: 200 }),
  slug: t.Optional(t.String({ minLength: 2, maxLength: 220 })),
  cityId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  propertyId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  shortDescription: t.Optional(nstr(300)),
  story: t.Optional(nstr(20000)),
  location: t.Optional(nstr(1000)),
  meetingPoint: t.Optional(nstr(1000)),
  lat: t.Optional(t.Nullable(t.Number())),
  lng: t.Optional(t.Nullable(t.Number())),
  durationMinutes: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
  price: t.Optional(t.Nullable(money)),
  suitableFor: t.Optional(strList()),
  included: t.Optional(strList()),
  excluded: t.Optional(strList()),
  hostName: t.Optional(nstr(160)),
  hostInfo: t.Optional(nstr(5000)),
  availabilityNote: t.Optional(nstr(2000)),
  isBookable: t.Optional(t.Boolean()),
  isActive: t.Optional(t.Boolean()),
  coverImageUrl: t.Optional(nstr(2000)),
  sort: t.Optional(t.Integer()),
  seo: t.Optional(t.Nullable(seoSchema)),
};

const experienceSlugExists = (exceptId?: string) => async (slug: string) =>
  !!(await db.query.experiences.findFirst({
    where: and(eq(experiences.slug, slug), exceptId ? ne(experiences.id, exceptId) : undefined),
  }));
const collectionSlugExists = (exceptId?: string) => async (slug: string) =>
  !!(await db.query.collections.findFirst({
    where: and(eq(collections.slug, slug), exceptId ? ne(collections.id, exceptId) : undefined),
  }));

// ─── Collections ──────────────────────────────────────────────────────────────

type CollectionRow = typeof collections.$inferSelect;

async function adminCollections(rows: CollectionRow[]) {
  if (!rows.length) return [];
  const [cards, items] = await Promise.all([
    buildCollectionCards(rows),
    db
      .select()
      .from(collectionItems)
      .where(inArray(collectionItems.collectionId, rows.map((r) => r.id)))
      .orderBy(asc(collectionItems.sort)),
  ]);
  const itemMap = groupBy(items, (i) => i.collectionId);
  return rows.map((c, i) => ({
    ...cards[i],
    cityId: c.cityId,
    isActive: c.isActive,
    sort: c.sort,
    seo: c.seo ?? null,
    propertyIds: (itemMap.get(c.id) ?? []).map((it) => it.propertyId),
    totalItems: (itemMap.get(c.id) ?? []).length,
  }));
}

const collectionFields = {
  title: t.String({ minLength: 2, maxLength: 160 }),
  slug: t.Optional(t.String({ minLength: 2, maxLength: 180 })),
  description: t.Optional(nstr(5000)),
  cityId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  coverImageUrl: t.Optional(nstr(2000)),
  sort: t.Optional(t.Integer()),
  isActive: t.Optional(t.Boolean()),
  seo: t.Optional(t.Nullable(seoSchema)),
};

// ─── Banners ──────────────────────────────────────────────────────────────────

type BannerRow = typeof banners.$inferSelect;

async function adminBanners(rows: BannerRow[]) {
  const ids = [...new Set(rows.map((r) => r.propertyId).filter((x): x is string => !!x))];
  const props = ids.length
    ? await db.select({ id: properties.id, slug: properties.slug }).from(properties).where(inArray(properties.id, ids))
    : [];
  const slugMap = new Map(props.map((p) => [p.id, p.slug]));
  return rows.map((b) => ({
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    videoUrl: b.videoUrl,
    hlsUrl: b.hlsUrl,
    posterUrl: b.posterUrl,
    ctaLabel: b.ctaLabel,
    ctaUrl: b.ctaUrl,
    propertySlug: b.propertyId ? (slugMap.get(b.propertyId) ?? null) : null,
    propertyId: b.propertyId,
    sort: b.sort,
    isActive: b.isActive,
    startsAt: iso(b.startsAt),
    endsAt: iso(b.endsAt),
    createdAt: iso(b.createdAt)!,
    updatedAt: iso(b.updatedAt)!,
  }));
}

const bannerFields = {
  title: t.String({ minLength: 1, maxLength: 200 }),
  subtitle: t.Optional(nstr(2000)),
  videoUrl: t.Optional(nstr(2000)),
  hlsUrl: t.Optional(nstr(2000)),
  posterUrl: t.Optional(nstr(2000)),
  ctaLabel: t.Optional(nstr(60)),
  ctaUrl: t.Optional(nstr(2000)),
  propertyId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  sort: t.Optional(t.Integer()),
  isActive: t.Optional(t.Boolean()),
  startsAt: t.Optional(t.Nullable(t.String({ format: "date-time" }))),
  endsAt: t.Optional(t.Nullable(t.String({ format: "date-time" }))),
};
const bannerCols = (b: Record<string, unknown>) => {
  const cols: Record<string, unknown> = defined(b);
  for (const k of ["startsAt", "endsAt"]) if (typeof cols[k] === "string") cols[k] = new Date(cols[k] as string);
  return cols;
};

// ─── Home sections ────────────────────────────────────────────────────────────

const HOME_SECTION_TYPES = [
  "RECOMMENDED", "PROPERTY_TYPES", "FEATURED", "VIDEO_DISCOVERY", "EXPERIENCES",
  "CITIES", "COLLECTIONS", "CITY_SPOTLIGHT", "WHY_BOOKMESTAYS",
] as const;
const toSection = (s: typeof homeSections.$inferSelect) => ({
  id: s.id,
  type: s.type,
  title: s.title,
  subtitle: s.subtitle,
  config: s.config,
  sort: s.sort,
  isActive: s.isActive,
  updatedAt: iso(s.updatedAt)!,
});
const listSections = async () =>
  (await db.select().from(homeSections).orderBy(asc(homeSections.sort), asc(homeSections.createdAt))).map(toSection);

// ─── Amenities ────────────────────────────────────────────────────────────────

const amenityFields = {
  code: t.String({ minLength: 2, maxLength: 60, pattern: "^[a-z0-9_]+$" }),
  name: t.String({ minLength: 2, maxLength: 120 }),
  icon: t.Optional(nstr(60)),
  category: t.Optional(t.String({ maxLength: 60 })),
  scope: t.Optional(lit(["PROPERTY", "ROOM", "BOTH"] as const)),
  sort: t.Optional(t.Integer()),
};

export const adminCms = new Elysia({ name: "admin-cms" })
  .use(authPlugin)
  .guard({ auth: ADMIN_ROLES }, (app) =>
    app
      // ─── Experiences ──────────────────────────────────────────────────────
      .get(
        "/experiences",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const where = and(
            query.cityId ? eq(experiences.cityId, query.cityId) : undefined,
            query.q ? ilike(experiences.title, `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
            query.isActive ? eq(experiences.isActive, query.isActive === "true") : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(experiences).where(where).orderBy(asc(experiences.sort), desc(experiences.createdAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(experiences).where(where),
          ]);
          return paginated(await adminExperiences(rows), n, page, limit);
        },
        {
          query: t.Object({
            cityId: t.Optional(t.String({ format: "uuid" })),
            q: t.Optional(t.String()),
            isActive: t.Optional(t.String()),
            ...pageQuery,
          }),
        },
      )
      .get(
        "/experiences/:id",
        async ({ params }) => {
          const e = await db.query.experiences.findFirst({ where: eq(experiences.id, params.id) });
          if (!e) throw notFound("Experience");
          return (await adminExperiences([e]))[0];
        },
        { params: idParams },
      )
      .post(
        "/experiences",
        async ({ authUser, body }) => {
          await Promise.all([assertCity(body.cityId), assertProperty(body.propertyId)]);
          const slug = await uniqueSlug(body.slug ?? body.title, experienceSlugExists());
          const [row] = await db.insert(experiences).values({ ...defined(body), slug }).returning();
          await audit(authUser, "experience.create", "experience", row.id, body);
          return (await adminExperiences([row]))[0];
        },
        { body: t.Object(experienceFields) },
      )
      .patch(
        "/experiences/:id",
        async ({ authUser, params, body }) => {
          const e = await db.query.experiences.findFirst({ where: eq(experiences.id, params.id) });
          if (!e) throw notFound("Experience");
          await Promise.all([assertCity(body.cityId), assertProperty(body.propertyId)]);
          const cols: Record<string, unknown> = defined(body);
          if (body.slug !== undefined) {
            cols.slug = slugify(body.slug);
            if (await experienceSlugExists(e.id)(cols.slug as string)) throw conflict("Another experience uses this slug");
          }
          const [row] = await db.update(experiences).set(cols).where(eq(experiences.id, e.id)).returning();
          await audit(authUser, "experience.update", "experience", e.id, body);
          return (await adminExperiences([row]))[0];
        },
        { params: idParams, body: t.Partial(t.Object(experienceFields)) },
      )
      .delete(
        "/experiences/:id",
        async ({ authUser, params }) => {
          const [row] = await db.delete(experiences).where(eq(experiences.id, params.id)).returning().catch(() => {
            throw conflict("This experience is referenced by bookings — deactivate it instead");
          });
          if (!row) throw notFound("Experience");
          await audit(authUser, "experience.delete", "experience", row.id, { title: row.title });
          return { ok: true };
        },
        { params: idParams },
      )

      // ─── Collections ──────────────────────────────────────────────────────
      .get("/collections", async () =>
        adminCollections(await db.select().from(collections).orderBy(asc(collections.sort), asc(collections.title))),
      )
      .get(
        "/collections/:id",
        async ({ params }) => {
          const c = await db.query.collections.findFirst({ where: eq(collections.id, params.id) });
          if (!c) throw notFound("Collection");
          return (await adminCollections([c]))[0];
        },
        { params: idParams },
      )
      .post(
        "/collections",
        async ({ authUser, body }) => {
          await assertCity(body.cityId);
          const slug = await uniqueSlug(body.slug ?? body.title, collectionSlugExists());
          const [row] = await db.insert(collections).values({ ...defined(body), slug }).returning();
          await audit(authUser, "collection.create", "collection", row.id, body);
          return (await adminCollections([row]))[0];
        },
        { body: t.Object(collectionFields) },
      )
      .patch(
        "/collections/:id",
        async ({ authUser, params, body }) => {
          const c = await db.query.collections.findFirst({ where: eq(collections.id, params.id) });
          if (!c) throw notFound("Collection");
          await assertCity(body.cityId);
          const cols: Record<string, unknown> = defined(body);
          if (body.slug !== undefined) {
            cols.slug = slugify(body.slug);
            if (await collectionSlugExists(c.id)(cols.slug as string)) throw conflict("Another collection uses this slug");
          }
          const [row] = await db.update(collections).set(cols).where(eq(collections.id, c.id)).returning();
          await audit(authUser, "collection.update", "collection", c.id, body);
          return (await adminCollections([row]))[0];
        },
        { params: idParams, body: t.Partial(t.Object(collectionFields)) },
      )
      .put(
        "/collections/:id/items",
        async ({ authUser, params, body }) => {
          const c = await db.query.collections.findFirst({ where: eq(collections.id, params.id) });
          if (!c) throw notFound("Collection");
          const ids = [...new Set(body.propertyIds)];
          if (ids.length) {
            const found = await db.select({ id: properties.id }).from(properties).where(inArray(properties.id, ids));
            if (found.length !== ids.length) throw badRequest("Some properties do not exist");
          }
          await db.transaction(async (tx) => {
            await tx.delete(collectionItems).where(eq(collectionItems.collectionId, c.id));
            if (ids.length)
              await tx.insert(collectionItems).values(ids.map((propertyId, sort) => ({ collectionId: c.id, propertyId, sort })));
          });
          await audit(authUser, "collection.items", "collection", c.id, { propertyIds: ids });
          return (await adminCollections([c]))[0];
        },
        { params: idParams, body: t.Object({ propertyIds: t.Array(t.String({ format: "uuid" }), { maxItems: 200 }) }) },
      )
      .delete(
        "/collections/:id",
        async ({ authUser, params }) => {
          const [row] = await db.delete(collections).where(eq(collections.id, params.id)).returning();
          if (!row) throw notFound("Collection");
          await audit(authUser, "collection.delete", "collection", row.id, { title: row.title });
          return { ok: true };
        },
        { params: idParams },
      )

      // ─── Banners ──────────────────────────────────────────────────────────
      .get("/banners", async () =>
        adminBanners(await db.select().from(banners).orderBy(asc(banners.sort), desc(banners.createdAt))),
      )
      .get(
        "/banners/:id",
        async ({ params }) => {
          const b = await db.query.banners.findFirst({ where: eq(banners.id, params.id) });
          if (!b) throw notFound("Banner");
          return (await adminBanners([b]))[0];
        },
        { params: idParams },
      )
      .post(
        "/banners",
        async ({ authUser, body }) => {
          await assertProperty(body.propertyId);
          const [row] = await db.insert(banners).values(bannerCols(body) as typeof banners.$inferInsert).returning();
          await audit(authUser, "banner.create", "banner", row.id, body);
          return (await adminBanners([row]))[0];
        },
        { body: t.Object(bannerFields) },
      )
      .patch(
        "/banners/:id",
        async ({ authUser, params, body }) => {
          await assertProperty(body.propertyId);
          const [row] = await db.update(banners).set(bannerCols(body)).where(eq(banners.id, params.id)).returning();
          if (!row) throw notFound("Banner");
          await audit(authUser, "banner.update", "banner", row.id, body);
          return (await adminBanners([row]))[0];
        },
        { params: idParams, body: t.Partial(t.Object(bannerFields)) },
      )
      .delete(
        "/banners/:id",
        async ({ authUser, params }) => {
          const [row] = await db.delete(banners).where(eq(banners.id, params.id)).returning();
          if (!row) throw notFound("Banner");
          await audit(authUser, "banner.delete", "banner", row.id, { title: row.title });
          return { ok: true };
        },
        { params: idParams },
      )

      // ─── Home sections ────────────────────────────────────────────────────
      .get("/home-sections", () => listSections())
      .put(
        "/home-sections",
        async ({ authUser, body }) => {
          const ids = body.sections.map((s) => s.id);
          const found = ids.length
            ? await db.select({ id: homeSections.id }).from(homeSections).where(inArray(homeSections.id, ids))
            : [];
          if (found.length !== new Set(ids).size) throw badRequest("Some home sections do not exist");
          await db.transaction(async (tx) => {
            for (const s of body.sections) {
              const { id, ...rest } = s;
              await tx.update(homeSections).set(defined(rest)).where(eq(homeSections.id, id));
            }
          });
          await audit(authUser, "home_sections.update", "home_section", null, body);
          return listSections();
        },
        {
          body: t.Object({
            sections: t.Array(
              t.Object({
                id: t.String({ format: "uuid" }),
                title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
                subtitle: t.Optional(nstr(1000)),
                config: t.Optional(t.Record(t.String(), t.Unknown())),
                sort: t.Optional(t.Integer()),
                isActive: t.Optional(t.Boolean()),
              }),
              { maxItems: 50 },
            ),
          }),
        },
      )
      .post(
        "/home-sections",
        async ({ authUser, body }) => {
          const [row] = await db.insert(homeSections).values(defined(body) as typeof homeSections.$inferInsert).returning();
          await audit(authUser, "home_section.create", "home_section", row.id, body);
          return toSection(row);
        },
        {
          body: t.Object({
            type: lit(HOME_SECTION_TYPES),
            title: t.String({ minLength: 1, maxLength: 200 }),
            subtitle: t.Optional(nstr(1000)),
            config: t.Optional(t.Record(t.String(), t.Unknown())),
            sort: t.Optional(t.Integer()),
            isActive: t.Optional(t.Boolean()),
          }),
        },
      )
      .delete(
        "/home-sections/:id",
        async ({ authUser, params }) => {
          const [row] = await db.delete(homeSections).where(eq(homeSections.id, params.id)).returning();
          if (!row) throw notFound("Home section");
          await audit(authUser, "home_section.delete", "home_section", row.id, { type: row.type, title: row.title });
          return { ok: true };
        },
        { params: idParams },
      )

      // ─── Amenities ────────────────────────────────────────────────────────
      .get("/amenities", async () =>
        (await db.select().from(amenities).orderBy(asc(amenities.sort), asc(amenities.name))).map((a) => ({
          ...toAmenity(a),
          sort: a.sort,
        })),
      )
      .post(
        "/amenities",
        async ({ authUser, body }) => {
          if (await db.query.amenities.findFirst({ where: eq(amenities.code, body.code) }))
            throw conflict("An amenity with this code already exists");
          const [row] = await db.insert(amenities).values(defined(body) as typeof amenities.$inferInsert).returning();
          invalidateMetaCache();
          await audit(authUser, "amenity.create", "amenity", row.id, body);
          return { ...toAmenity(row), sort: row.sort };
        },
        { body: t.Object(amenityFields) },
      )
      .patch(
        "/amenities/:id",
        async ({ authUser, params, body }) => {
          if (body.code) {
            const clash = await db.query.amenities.findFirst({
              where: and(eq(amenities.code, body.code), ne(amenities.id, params.id)),
            });
            if (clash) throw conflict("An amenity with this code already exists");
          }
          const [row] = await db.update(amenities).set(defined(body)).where(eq(amenities.id, params.id)).returning();
          if (!row) throw notFound("Amenity");
          invalidateMetaCache();
          await audit(authUser, "amenity.update", "amenity", row.id, body);
          return { ...toAmenity(row), sort: row.sort };
        },
        { params: idParams, body: t.Partial(t.Object(amenityFields)) },
      )
      .delete(
        "/amenities/:id",
        async ({ authUser, params }) => {
          const [row] = await db.delete(amenities).where(eq(amenities.id, params.id)).returning();
          if (!row) throw notFound("Amenity");
          invalidateMetaCache();
          await audit(authUser, "amenity.delete", "amenity", row.id, { code: row.code });
          return { ok: true };
        },
        { params: idParams },
      ),
  );
