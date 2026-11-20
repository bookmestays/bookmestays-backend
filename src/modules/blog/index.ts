// Blog: admin/writer CRUD (/admin/blog) + public read API (/public/blog).
// Writers (BLOG_EDITOR) and admins manage posts; the site renders /blog, /blog/<slug>,
// /blog/category/<slug> and lists every published post in the sitemap.
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { blogPosts, cities, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin, BLOG_ROLES } from "../../lib/auth";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { pageParams, paginated, slugify } from "../../lib/utils";
import { uniqueSlug } from "../../services/catalog/accounts";
import { iso } from "../../services/catalog/dto";
import { defined, lit, nstr, pageQuery, seoSchema } from "../admin/schemas";

type PostRow = typeof blogPosts.$inferSelect;

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const likeOf = (q: string) => `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** URL slug for a free-text category ("Travel Guides" → "travel-guides"). Mirrors `categorySlugSql`. */
export const categorySlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const categorySlugSql = sql<string>`trim(both '-' from regexp_replace(lower(${blogPosts.category}), '[^a-z0-9]+', '-', 'g'))`;

/** Strips Markdown syntax to plain text (for excerpts and word counts). */
export function markdownToText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/^-{3,}$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const readingMinutes = (content: string) => Math.max(1, Math.round(markdownToText(content).split(" ").filter(Boolean).length / 200));

function excerptOf(p: Pick<PostRow, "excerpt" | "content">) {
  if (p.excerpt?.trim()) return p.excerpt.trim();
  const text = markdownToText(p.content);
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, "")}…` : text;
}

/** Published and not scheduled for the future. */
const visible = () => and(eq(blogPosts.status, "PUBLISHED"), isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, new Date()));

const slugTaken = (exceptId?: string) => async (slug: string) =>
  !!(
    await db
      .select({ id: blogPosts.id })
      .from(blogPosts)
      .where(and(eq(blogPosts.slug, slug), exceptId ? ne(blogPosts.id, exceptId) : undefined))
      .limit(1)
  )[0];

async function cityMap(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, { id: string; name: string; slug: string }>();
  const rows = await db.select({ id: cities.id, name: cities.name, slug: cities.slug }).from(cities).where(inArray(cities.id, unique));
  return new Map(rows.map((c) => [c.id, c]));
}

function toCard(p: PostRow) {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    excerpt: excerptOf(p),
    coverImageUrl: p.coverImageUrl,
    coverImageAlt: p.coverImageAlt,
    category: p.category,
    categorySlug: p.category ? categorySlug(p.category) : null,
    tags: p.tags,
    authorName: p.authorName,
    readingMinutes: p.readingMinutes,
    isFeatured: p.isFeatured,
    publishedAt: iso(p.publishedAt),
    updatedAt: iso(p.updatedAt)!,
  };
}

async function toAdmin(rows: PostRow[]) {
  const cmap = await cityMap(rows.map((r) => r.cityId));
  return rows.map((p) => ({
    ...toCard(p),
    excerpt: p.excerpt,
    content: p.content,
    status: p.status,
    previousSlugs: p.previousSlugs,
    cityId: p.cityId,
    cityName: p.cityId ? (cmap.get(p.cityId)?.name ?? null) : null,
    authorId: p.authorId,
    seo: p.seo ?? null,
    createdAt: iso(p.createdAt)!,
  }));
}

// ─── Input schema ─────────────────────────────────────────────────────────────

const postFields = {
  title: t.String({ minLength: 3, maxLength: 200 }),
  slug: t.Optional(t.String({ minLength: 2, maxLength: 220 })),
  excerpt: t.Optional(nstr(500)),
  content: t.Optional(t.String({ maxLength: 200_000 })),
  coverImageUrl: t.Optional(nstr(2000)),
  coverImageAlt: t.Optional(nstr(200)),
  category: t.Optional(nstr(80)),
  tags: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 60 }), { maxItems: 20 })),
  cityId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  status: t.Optional(lit(["DRAFT", "PUBLISHED"] as const)),
  /** ISO time. Future = scheduled. Defaults to "now" the first time a post is published. */
  publishedAt: t.Optional(t.Nullable(t.String({ format: "date-time" }))),
  isFeatured: t.Optional(t.Boolean()),
  authorName: t.Optional(nstr(160)),
  seo: t.Optional(t.Nullable(seoSchema)),
};
type PostInput = Partial<{
  [K in keyof typeof postFields]: (typeof postFields)[K]["static"];
}>;

async function normalize(body: PostInput, current: PostRow | null) {
  if (body.cityId && !(await db.query.cities.findFirst({ where: eq(cities.id, body.cityId) })))
    throw badRequest("Selected city does not exist");
  const cols: Partial<typeof blogPosts.$inferInsert> = defined({
    title: body.title?.trim(),
    excerpt: body.excerpt === undefined ? undefined : body.excerpt?.trim() || null,
    content: body.content,
    coverImageUrl: body.coverImageUrl === undefined ? undefined : body.coverImageUrl?.trim() || null,
    coverImageAlt: body.coverImageAlt === undefined ? undefined : body.coverImageAlt?.trim() || null,
    category: body.category === undefined ? undefined : body.category?.trim() || null,
    tags: body.tags ? [...new Set(body.tags.map((x) => x.trim()).filter(Boolean))] : undefined,
    cityId: body.cityId,
    status: body.status,
    isFeatured: body.isFeatured,
    authorName: body.authorName === undefined ? undefined : body.authorName?.trim() || null,
    seo: body.seo,
  });
  if (body.content !== undefined) cols.readingMinutes = readingMinutes(body.content);
  if (body.publishedAt !== undefined) cols.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;

  // Publishing for the first time → stamp the publish time.
  const status = body.status ?? current?.status ?? "DRAFT";
  const publishedAt = cols.publishedAt !== undefined ? cols.publishedAt : (current?.publishedAt ?? null);
  if (status === "PUBLISHED" && !publishedAt) cols.publishedAt = new Date();
  if (status === "PUBLISHED") {
    const content = body.content ?? current?.content ?? "";
    if (markdownToText(content).length < 50) throw badRequest("Write some content (at least a few sentences) before publishing");
  }

  // Slug: explicit, or derived from the title for new posts.
  if (body.slug !== undefined || !current) {
    const wanted = slugify(body.slug ?? "").slice(0, 200);
    if (body.slug !== undefined && !wanted) throw badRequest("Slug must contain letters or numbers");
    let slug: string;
    if (wanted) {
      if (!SLUG_RE.test(wanted)) throw badRequest("Slug can only use lowercase letters, numbers and dashes");
      if (await slugTaken(current?.id)(wanted)) throw conflict("Another post already uses this URL slug");
      slug = wanted;
    } else {
      slug = await uniqueSlug(body.title ?? current?.title ?? "post", slugTaken(current?.id));
    }
    cols.slug = slug;
    // Keep old links of an already-published post alive (301 → new slug).
    if (current && slug !== current.slug) {
      const prev = current.publishedAt ? [current.slug, ...current.previousSlugs] : current.previousSlugs;
      cols.previousSlugs = [...new Set(prev)].filter((s) => s !== slug).slice(0, 20);
    }
  }
  return cols;
}

async function loadPost(id: string) {
  const p = await db.query.blogPosts.findFirst({ where: eq(blogPosts.id, id) });
  if (!p) throw notFound("Blog post");
  return p;
}

// ─── Admin / writer API ───────────────────────────────────────────────────────

const adminBlog = new Elysia({ name: "admin-blog", prefix: "/admin/blog", tags: ["Blog"] })
  .use(authPlugin)
  .guard({ auth: BLOG_ROLES }, (app) =>
    app
      .get(
        "/",
        async ({ query }) => {
          const { page, limit, offset } = pageParams(query);
          const where = and(
            query.status === "DRAFT" || query.status === "PUBLISHED" ? eq(blogPosts.status, query.status) : undefined,
            query.status === "SCHEDULED" ? and(eq(blogPosts.status, "PUBLISHED"), sql`${blogPosts.publishedAt} > now()`) : undefined,
            query.q ? or(ilike(blogPosts.title, likeOf(query.q)), ilike(blogPosts.slug, likeOf(query.q))) : undefined,
          );
          const [rows, [{ n }]] = await Promise.all([
            db.select().from(blogPosts).where(where).orderBy(desc(blogPosts.updatedAt)).limit(limit).offset(offset),
            db.select({ n: count() }).from(blogPosts).where(where),
          ]);
          return paginated(await toAdmin(rows), n, page, limit);
        },
        { query: t.Object({ status: t.Optional(t.String()), q: t.Optional(t.String()), ...pageQuery }) },
      )
      // Categories and tags already in use (form suggestions).
      .get("/taxonomy", async () => {
        const [cats, tags] = await Promise.all([
          db
            .selectDistinct({ category: blogPosts.category })
            .from(blogPosts)
            .where(isNotNull(blogPosts.category))
            .orderBy(asc(blogPosts.category)),
          db.execute<{ tag: string }>(sql`select distinct unnest(${blogPosts.tags}) as tag from ${blogPosts} order by 1 limit 300`),
        ]);
        return { categories: cats.map((c) => c.category!), tags: [...tags].map((r) => r.tag) };
      })
      .get("/:id", async ({ params }) => (await toAdmin([await loadPost(params.id)]))[0], { params: idParams })
      .post(
        "/",
        async ({ authUser, body }) => {
          const cols = await normalize(body, null);
          const me = await db.query.users.findFirst({ where: eq(users.id, authUser.id), columns: { name: true } });
          const [row] = await db
            .insert(blogPosts)
            .values({
              ...cols,
              title: cols.title!,
              slug: cols.slug!,
              authorId: authUser.id,
              authorName: cols.authorName ?? me?.name ?? null,
            })
            .returning();
          await audit(authUser, "blog.create", "blog_post", row.id, { title: row.title, slug: row.slug, status: row.status });
          return (await toAdmin([row]))[0];
        },
        { body: t.Object(postFields) },
      )
      .patch(
        "/:id",
        async ({ authUser, params, body }) => {
          const current = await loadPost(params.id);
          const cols = await normalize(body, current);
          const [row] = await db.update(blogPosts).set(cols).where(eq(blogPosts.id, current.id)).returning();
          const action = body.status && body.status !== current.status ? (body.status === "PUBLISHED" ? "blog.publish" : "blog.unpublish") : "blog.update";
          await audit(authUser, action, "blog_post", row.id, { title: row.title, slug: row.slug, status: row.status });
          return (await toAdmin([row]))[0];
        },
        { params: idParams, body: t.Partial(t.Object(postFields)) },
      )
      .delete(
        "/:id",
        async ({ authUser, params }) => {
          const p = await loadPost(params.id);
          // Writers may discard drafts; deleting a live post (and its search ranking) needs an admin.
          if (!ADMIN_ROLES.includes(authUser.role) && p.publishedAt)
            throw forbidden("Only an admin can delete a post that has been published. Unpublish it instead.");
          await db.delete(blogPosts).where(eq(blogPosts.id, p.id));
          await audit(authUser, "blog.delete", "blog_post", p.id, { title: p.title, slug: p.slug });
          return { ok: true };
        },
        { params: idParams },
      ),
  );

// ─── Public API ───────────────────────────────────────────────────────────────

const publicBlog = new Elysia({ name: "public-blog", prefix: "/public/blog", tags: ["Blog"] })
  .get(
    "/",
    async ({ query }) => {
      const { page, limit, offset } = pageParams(query);
      const conds: (SQL | undefined)[] = [visible()];
      if (query.category) conds.push(sql`${categorySlugSql} = ${query.category}`);
      if (query.tag) conds.push(sql`${query.tag} = ANY(${blogPosts.tags})`);
      if (query.q) conds.push(or(ilike(blogPosts.title, likeOf(query.q)), ilike(blogPosts.excerpt, likeOf(query.q))));
      const where = and(...conds);
      const [rows, [{ n }]] = await Promise.all([
        db.select().from(blogPosts).where(where).orderBy(desc(blogPosts.publishedAt)).limit(limit).offset(offset),
        db.select({ n: count() }).from(blogPosts).where(where),
      ]);
      return paginated(rows.map(toCard), n, page, limit);
    },
    {
      query: t.Object({
        category: t.Optional(t.String({ maxLength: 100 })),
        tag: t.Optional(t.String({ maxLength: 60 })),
        q: t.Optional(t.String({ maxLength: 100 })),
        ...pageQuery,
      }),
    },
  )
  .get("/categories", async () => {
    const rows = await db
      .select({ name: blogPosts.category, n: count() })
      .from(blogPosts)
      .where(and(visible(), isNotNull(blogPosts.category)))
      .groupBy(blogPosts.category)
      .orderBy(desc(count()), asc(blogPosts.category));
    // Merge spellings that map to the same slug ("Travel guides" / "Travel Guides").
    const bySlug = new Map<string, { name: string; slug: string; count: number }>();
    for (const r of rows) {
      const slug = categorySlug(r.name!);
      if (!slug) continue;
      const c = bySlug.get(slug);
      if (c) c.count += r.n;
      else bySlug.set(slug, { name: r.name!, slug, count: r.n });
    }
    return [...bySlug.values()];
  })
  // Everything the sitemap needs, in one call.
  .get("/sitemap", async () => {
    const rows = await db
      .select({
        slug: blogPosts.slug,
        title: blogPosts.title,
        category: blogPosts.category,
        coverImageUrl: blogPosts.coverImageUrl,
        publishedAt: blogPosts.publishedAt,
        updatedAt: blogPosts.updatedAt,
      })
      .from(blogPosts)
      .where(visible())
      .orderBy(desc(blogPosts.publishedAt))
      .limit(10_000);
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      categorySlug: r.category ? categorySlug(r.category) : null,
      coverImageUrl: r.coverImageUrl,
      publishedAt: iso(r.publishedAt),
      updatedAt: iso(r.updatedAt)!,
    }));
  })
  .get("/:slug", async ({ params }) => {
    const slug = params.slug.toLowerCase();
    const p = await db.query.blogPosts.findFirst({ where: and(eq(blogPosts.slug, slug), visible()) });
    if (!p) {
      // Old URL of a renamed post → tell the site where it moved (permanent redirect).
      const moved = await db.query.blogPosts.findFirst({
        where: and(sql`${slug} = ANY(${blogPosts.previousSlugs})`, visible()),
        columns: { slug: true },
      });
      if (moved) return { redirect: moved.slug };
      throw notFound("Blog post");
    }
    const [cmap, sameCategory] = await Promise.all([
      cityMap([p.cityId]),
      db
        .select()
        .from(blogPosts)
        .where(and(visible(), ne(blogPosts.id, p.id), p.category ? eq(blogPosts.category, p.category) : undefined))
        .orderBy(desc(blogPosts.publishedAt))
        .limit(3),
    ]);
    let related = sameCategory;
    if (related.length < 3) {
      const more = await db
        .select()
        .from(blogPosts)
        .where(and(visible(), ne(blogPosts.id, p.id), notInArray(blogPosts.id, related.map((r) => r.id).concat(p.id))))
        .orderBy(desc(blogPosts.publishedAt))
        .limit(3 - related.length);
      related = [...related, ...more];
    }
    const city = p.cityId ? (cmap.get(p.cityId) ?? null) : null;
    return {
      ...toCard(p),
      content: p.content,
      city: city ? { name: city.name, slug: city.slug } : null,
      seo: p.seo ?? null,
      related: related.map(toCard),
    };
  });

export const blogModule = new Elysia({ name: "blog" }).use(adminBlog).use(publicBlog);
