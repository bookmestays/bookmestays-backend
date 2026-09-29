// Admin: cities + areas.
import { and, asc, count, eq, ne } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { areas, cities, experiences, properties } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { slugify } from "../../lib/utils";
import { buildCityCards } from "../../services/catalog/cards";
import { iso, toArea } from "../../services/catalog/dto";
import { invalidateMetaCache } from "../public";
import { defined, nstr, seoSchema } from "./schemas";

type CityRow = typeof cities.$inferSelect;

async function adminCities(rows: CityRow[]) {
  const cards = await buildCityCards(rows);
  const [areaCounts, allCounts] = await Promise.all([
    db.select({ cityId: areas.cityId, n: count() }).from(areas).groupBy(areas.cityId),
    db.select({ cityId: properties.cityId, n: count() }).from(properties).groupBy(properties.cityId),
  ]);
  const areaMap = new Map(areaCounts.map((a) => [a.cityId, a.n]));
  const allMap = new Map(allCounts.map((a) => [a.cityId, a.n]));
  return rows.map((c, i) => ({
    ...cards[i],
    country: c.country,
    travelInfo: c.travelInfo,
    foodGuide: c.foodGuide,
    lat: c.lat,
    lng: c.lng,
    seo: c.seo ?? null,
    isActive: c.isActive,
    sort: c.sort,
    areaCount: areaMap.get(c.id) ?? 0,
    totalPropertyCount: allMap.get(c.id) ?? 0,
    createdAt: iso(c.createdAt)!,
    updatedAt: iso(c.updatedAt)!,
  }));
}

const cityFields = {
  name: t.String({ minLength: 2, maxLength: 120 }),
  slug: t.Optional(t.String({ minLength: 2, maxLength: 140 })),
  state: t.Optional(nstr(120)),
  country: t.Optional(t.String({ maxLength: 80 })),
  intro: t.Optional(nstr(5000)),
  travelInfo: t.Optional(nstr(20000)),
  foodGuide: t.Optional(nstr(20000)),
  lat: t.Optional(t.Nullable(t.Number())),
  lng: t.Optional(t.Nullable(t.Number())),
  coverImageUrl: t.Optional(nstr(2000)),
  isFeatured: t.Optional(t.Boolean()),
  isActive: t.Optional(t.Boolean()),
  sort: t.Optional(t.Integer()),
  seo: t.Optional(t.Nullable(seoSchema)),
};

const areaFields = {
  name: t.String({ minLength: 2, maxLength: 120 }),
  slug: t.Optional(t.String({ minLength: 2, maxLength: 140 })),
  description: t.Optional(nstr(5000)),
  isRecommended: t.Optional(t.Boolean()),
};

async function loadCity(id: string) {
  const c = await db.query.cities.findFirst({ where: eq(cities.id, id) });
  if (!c) throw notFound("City");
  return c;
}

async function assertCitySlugFree(slug: string, exceptId?: string) {
  const clash = await db.query.cities.findFirst({
    where: and(eq(cities.slug, slug), exceptId ? ne(cities.id, exceptId) : undefined),
  });
  if (clash) throw conflict("Another city already uses this slug");
}

async function assertAreaSlugFree(cityId: string, slug: string, exceptId?: string) {
  const clash = await db.query.areas.findFirst({
    where: and(eq(areas.cityId, cityId), eq(areas.slug, slug), exceptId ? ne(areas.id, exceptId) : undefined),
  });
  if (clash) throw conflict("Another area in this city already uses this slug");
}

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const areaParams = t.Object({ id: t.String({ format: "uuid" }), areaId: t.String({ format: "uuid" }) });

export const adminGeo = new Elysia({ name: "admin-geo" })
  .use(authPlugin)
  .guard({ auth: ADMIN_ROLES }, (app) =>
    app
      .get("/cities", async () => adminCities(await db.select().from(cities).orderBy(asc(cities.sort), asc(cities.name))))

      .get("/cities/:id", async ({ params }) => (await adminCities([await loadCity(params.id)]))[0], { params: idParams })

      .post(
        "/cities",
        async ({ authUser, body }) => {
          const slug = slugify(body.slug ?? body.name);
          if (!slug) throw badRequest("Invalid slug");
          await assertCitySlugFree(slug);
          const [row] = await db.insert(cities).values({ ...defined(body), slug }).returning();
          invalidateMetaCache();
          await audit(authUser, "city.create", "city", row.id, body);
          return (await adminCities([row]))[0];
        },
        { body: t.Object(cityFields) },
      )

      .patch(
        "/cities/:id",
        async ({ authUser, params, body }) => {
          await loadCity(params.id);
          const cols: Record<string, unknown> = defined(body);
          if (body.slug !== undefined) {
            cols.slug = slugify(body.slug);
            if (!cols.slug) throw badRequest("Invalid slug");
            await assertCitySlugFree(cols.slug as string, params.id);
          }
          const [row] = await db.update(cities).set(cols).where(eq(cities.id, params.id)).returning();
          invalidateMetaCache();
          await audit(authUser, "city.update", "city", params.id, body);
          return (await adminCities([row]))[0];
        },
        { params: idParams, body: t.Partial(t.Object(cityFields)) },
      )

      .delete(
        "/cities/:id",
        async ({ authUser, params }) => {
          const c = await loadCity(params.id);
          const [[{ n: props }], [{ n: exps }]] = await Promise.all([
            db.select({ n: count() }).from(properties).where(eq(properties.cityId, c.id)),
            db.select({ n: count() }).from(experiences).where(eq(experiences.cityId, c.id)),
          ]);
          if (props || exps)
            throw conflict(`This city is used by ${props} properties and ${exps} experiences — deactivate it instead`);
          await db.delete(cities).where(eq(cities.id, c.id));
          invalidateMetaCache();
          await audit(authUser, "city.delete", "city", c.id, { name: c.name });
          return { ok: true };
        },
        { params: idParams },
      )

      // ─── Areas ────────────────────────────────────────────────────────────
      .get(
        "/cities/:id/areas",
        async ({ params }) => {
          await loadCity(params.id);
          const rows = await db.select().from(areas).where(eq(areas.cityId, params.id)).orderBy(asc(areas.name));
          return rows.map(toArea);
        },
        { params: idParams },
      )

      .post(
        "/cities/:id/areas",
        async ({ authUser, params, body }) => {
          await loadCity(params.id);
          const slug = slugify(body.slug ?? body.name);
          if (!slug) throw badRequest("Invalid slug");
          await assertAreaSlugFree(params.id, slug);
          const [row] = await db
            .insert(areas)
            .values({ ...defined(body), slug, cityId: params.id })
            .returning();
          await audit(authUser, "area.create", "area", row.id, body);
          return toArea(row);
        },
        { params: idParams, body: t.Object(areaFields) },
      )

      .patch(
        "/cities/:id/areas/:areaId",
        async ({ authUser, params, body }) => {
          const a = await db.query.areas.findFirst({ where: and(eq(areas.id, params.areaId), eq(areas.cityId, params.id)) });
          if (!a) throw notFound("Area");
          const cols: Record<string, unknown> = defined(body);
          if (body.slug !== undefined) {
            cols.slug = slugify(body.slug);
            if (!cols.slug) throw badRequest("Invalid slug");
            await assertAreaSlugFree(params.id, cols.slug as string, a.id);
          }
          const [row] = await db.update(areas).set(cols).where(eq(areas.id, a.id)).returning();
          await audit(authUser, "area.update", "area", a.id, body);
          return toArea(row);
        },
        { params: areaParams, body: t.Partial(t.Object(areaFields)) },
      )

      .delete(
        "/cities/:id/areas/:areaId",
        async ({ authUser, params }) => {
          const a = await db.query.areas.findFirst({ where: and(eq(areas.id, params.areaId), eq(areas.cityId, params.id)) });
          if (!a) throw notFound("Area");
          await db.transaction(async (tx) => {
            await tx.update(properties).set({ areaId: null }).where(eq(properties.areaId, a.id));
            await tx.delete(areas).where(eq(areas.id, a.id));
          });
          await audit(authUser, "area.delete", "area", a.id, { name: a.name });
          return { ok: true };
        },
        { params: areaParams },
      ),
  );
