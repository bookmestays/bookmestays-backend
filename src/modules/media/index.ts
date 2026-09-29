import { stat } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { banners, cities, collections, experiences, media, nearbyPlaces, properties, roomTypes } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin, PARTNER_ROLES, type AuthUser } from "../../lib/auth";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { toMedia } from "../../services/catalog/dto";
import { syncOwnerMedia } from "../../services/catalog/maintenance";
import {
  deleteObject,
  KEY_RE,
  localStorageEnabled,
  presignUpload,
  publicUrlFor,
  UPLOADS_DIR,
  verifyLocalSig,
  writeLocal,
} from "../../services/catalog/storage";

const OWNER_TYPES = ["PROPERTY", "ROOM_TYPE", "NEARBY_PLACE", "EXPERIENCE", "CITY", "COLLECTION", "BANNER"] as const;
const PARTNER_OWNER_TYPES = ["PROPERTY", "ROOM_TYPE", "NEARBY_PLACE"];
const MEDIA_TAGS = [
  "EXTERIOR", "ROOM_WALKTHROUGH", "ROOM", "BATHROOM", "VIEW", "COMMON_AREA",
  "POOL", "DINING", "SURROUNDINGS", "EXPERIENCE", "AMENITY", "OTHER",
] as const;
type OwnerType = (typeof OWNER_TYPES)[number];

const MB = 1024 * 1024;
const ALLOWED = {
  IMAGE: {
    maxBytes: 15 * MB,
    types: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" } as Record<string, string>,
  },
  VIDEO: {
    maxBytes: 500 * MB,
    types: { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" } as Record<string, string>,
  },
};

const ownerTypeSchema = t.Union(OWNER_TYPES.map((o) => t.Literal(o)));
const tagSchema = t.Union(MEDIA_TAGS.map((o) => t.Literal(o)));
const kindSchema = t.Union([t.Literal("IMAGE"), t.Literal("VIDEO")]);

/** Partner property that owns a PROPERTY / ROOM_TYPE / NEARBY_PLACE media owner (null if unknown). */
async function owningPartner(ownerType: string, ownerId: string): Promise<string | null> {
  if (ownerType === "PROPERTY") {
    const [r] = await db.select({ partnerId: properties.partnerId }).from(properties).where(eq(properties.id, ownerId));
    return r?.partnerId ?? null;
  }
  if (ownerType === "ROOM_TYPE") {
    const [r] = await db
      .select({ partnerId: properties.partnerId })
      .from(roomTypes)
      .innerJoin(properties, eq(properties.id, roomTypes.propertyId))
      .where(eq(roomTypes.id, ownerId));
    return r?.partnerId ?? null;
  }
  if (ownerType === "NEARBY_PLACE") {
    const [r] = await db
      .select({ partnerId: properties.partnerId })
      .from(nearbyPlaces)
      .innerJoin(properties, eq(properties.id, nearbyPlaces.propertyId))
      .where(eq(nearbyPlaces.id, ownerId));
    return r?.partnerId ?? null;
  }
  return null;
}

async function ownerExists(ownerType: OwnerType, ownerId: string) {
  const table = {
    PROPERTY: properties,
    ROOM_TYPE: roomTypes,
    NEARBY_PLACE: nearbyPlaces,
    EXPERIENCE: experiences,
    CITY: cities,
    COLLECTION: collections,
    BANNER: banners,
  }[ownerType];
  const [r] = await db.select({ id: table.id }).from(table).where(eq(table.id, ownerId));
  return !!r;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless `user` may manage media of this owner. */
async function assertAccess(user: AuthUser, ownerType: OwnerType, ownerId: string | null | undefined) {
  if (ownerId && !UUID_RE.test(ownerId)) throw notFound("Owner");
  if (ADMIN_ROLES.includes(user.role)) {
    if (ownerType !== "BANNER" && !ownerId) throw badRequest("ownerId is required");
    if (ownerId && !(await ownerExists(ownerType, ownerId))) throw notFound("Owner");
    return;
  }
  if (PARTNER_ROLES.includes(user.role) && user.partnerId) {
    if (!PARTNER_OWNER_TYPES.includes(ownerType)) throw forbidden("Only admins can manage this media");
    if (user.role === "PARTNER_STAFF" && !user.permissions.includes("content"))
      throw forbidden("Missing permission: content");
    if (!ownerId) throw badRequest("ownerId is required");
    if ((await owningPartner(ownerType, ownerId)) !== user.partnerId) throw notFound("Owner");
    return;
  }
  throw forbidden();
}

async function loadMediaForUser(user: AuthUser, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Media");
  const m = await db.query.media.findFirst({ where: eq(media.id, id) });
  if (!m) throw notFound("Media");
  try {
    await assertAccess(user, m.ownerType, m.ownerId);
  } catch (err) {
    if (err instanceof AppError && err.status === 403 && PARTNER_ROLES.includes(user.role) && !PARTNER_OWNER_TYPES.includes(m.ownerType))
      throw notFound("Media");
    throw err;
  }
  return m;
}

const keyPrefix = (ownerType: string, ownerId?: string | null) => `${ownerType.toLowerCase()}/${ownerId ?? "misc"}/`;

// ─── Local dev storage (non-production, no S3 keys) ───────────────────────────

const localUploads = new Elysia({ name: "media-local" })
  .put(
    "/media/local-upload/*",
    async ({ params, query, request }) => {
      if (!localStorageEnabled()) throw notFound("Route");
      const key = params["*"];
      if (!KEY_RE.test(key)) throw badRequest("Invalid upload key");
      const grant = verifyLocalSig(key, query as Record<string, string>);
      if (!grant) throw new AppError(403, "UPLOAD_URL_EXPIRED", "Upload link is invalid or expired");
      const ct = request.headers.get("content-type")?.split(";")[0].trim();
      if (ct && ct !== grant.contentType) throw badRequest("Content-Type does not match the presigned upload");
      const data = await request.arrayBuffer();
      if (!data.byteLength) throw badRequest("Empty upload");
      if (data.byteLength > grant.maxSize) throw new AppError(413, "TOO_LARGE", "File is larger than declared");
      await writeLocal(key, data);
      return { ok: true };
    },
    { parse: "none" },
  )
  .get("/uploads/*", async ({ params, request, set }) => {
    const key = params["*"];
    if (!KEY_RE.test(key)) throw notFound("File");
    const path = join(UPLOADS_DIR, key);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw notFound("File");
    const file = Bun.file(path);
    const size = info.size;
    const range = request.headers.get("range");
    const headers: Record<string, string> = {
      "Content-Type": file.type || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    };
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        set.status = 416;
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
      });
    }
    return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
  });

// ─── Authenticated media API ──────────────────────────────────────────────────

export const mediaModule = new Elysia({ name: "media", tags: ["Media"] })
  .use(localUploads)
  .use(authPlugin)
  .group("/media", (app) =>
    app
      .post(
        "/presign",
        async ({ authUser, body }) => {
          await assertAccess(authUser, body.ownerType, body.ownerId);
          const rule = ALLOWED[body.kind];
          const contentType = body.contentType.toLowerCase();
          const ext = rule.types[contentType];
          if (!ext)
            throw badRequest(
              body.kind === "IMAGE" ? "Images must be JPEG, PNG, WebP or AVIF" : "Videos must be MP4, MOV or WebM",
            );
          if (body.sizeBytes > rule.maxBytes)
            throw badRequest(body.kind === "IMAGE" ? "Images must be 15 MB or smaller" : "Videos must be 500 MB or smaller");
          const now = new Date();
          const key = `${keyPrefix(body.ownerType, body.ownerId)}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
          return presignUpload(key, contentType, body.sizeBytes);
        },
        {
          auth: true,
          body: t.Object({
            ownerType: ownerTypeSchema,
            ownerId: t.Optional(t.Nullable(t.String())),
            kind: kindSchema,
            fileName: t.String({ maxLength: 300 }),
            contentType: t.String({ maxLength: 100 }),
            sizeBytes: t.Integer({ minimum: 1 }),
          }),
        },
      )

      .post(
        "/",
        async ({ authUser, body }) => {
          await assertAccess(authUser, body.ownerType, body.ownerId);
          const isAdmin = ADMIN_ROLES.includes(authUser.role);
          if (!isAdmin) {
            if (!body.s3Key.startsWith(keyPrefix(body.ownerType, body.ownerId)) || !KEY_RE.test(body.s3Key))
              throw badRequest("Upload key does not belong to this item");
            if (body.url !== publicUrlFor(body.s3Key)) throw badRequest("Media URL does not match the upload");
          }
          const ownerId = body.ownerId ?? null;
          const [{ next }] = await db
            .select({ next: sql<number>`coalesce(max(${media.sort}) + 1, 0)`.mapWith(Number) })
            .from(media)
            .where(
              and(
                eq(media.ownerType, body.ownerType),
                ownerId ? eq(media.ownerId, ownerId) : sql`${media.ownerId} IS NULL`,
              ),
            );
          const [row] = await db
            .insert(media)
            .values({
              ownerType: body.ownerType,
              ownerId,
              kind: body.kind,
              s3Key: body.s3Key,
              url: body.url,
              posterUrl: body.posterUrl ?? null,
              tag: body.tag ?? "OTHER",
              title: body.title ?? null,
              caption: body.caption ?? null,
              durationSec: body.durationSec ?? null,
              width: body.width ?? null,
              height: body.height ?? null,
              mimeType: body.mimeType ?? null,
              sizeBytes: body.sizeBytes ?? null,
              sort: next,
              status: "READY",
              uploadedBy: authUser.id,
            })
            .returning();
          await syncOwnerMedia(row.ownerType, row.ownerId);
          await audit(authUser, "media.create", "media", row.id, { ownerType: row.ownerType, ownerId: row.ownerId, kind: row.kind });
          return toMedia(row);
        },
        {
          auth: true,
          body: t.Object({
            ownerType: ownerTypeSchema,
            ownerId: t.Optional(t.Nullable(t.String())),
            kind: kindSchema,
            s3Key: t.String({ minLength: 1, maxLength: 500 }),
            url: t.String({ minLength: 1, maxLength: 2000 }),
            posterUrl: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            tag: t.Optional(tagSchema),
            title: t.Optional(t.Nullable(t.String({ maxLength: 200 }))),
            caption: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            durationSec: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
            width: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
            height: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
            mimeType: t.Optional(t.String({ maxLength: 100 })),
            sizeBytes: t.Optional(t.Integer({ minimum: 0 })),
          }),
        },
      )

      .get(
        "/",
        async ({ authUser, query }) => {
          await assertAccess(authUser, query.ownerType, query.ownerId);
          const rows = await db
            .select()
            .from(media)
            .where(
              and(
                eq(media.ownerType, query.ownerType),
                query.ownerId ? eq(media.ownerId, query.ownerId) : sql`${media.ownerId} IS NULL`,
              ),
            )
            .orderBy(asc(media.sort), asc(media.createdAt));
          return rows.map(toMedia);
        },
        { auth: true, query: t.Object({ ownerType: ownerTypeSchema, ownerId: t.Optional(t.String()) }) },
      )

      .put(
        "/reorder",
        async ({ authUser, body }) => {
          const ids = [...new Set(body.ids)];
          if (!ids.length) return { ok: true };
          if (ids.some((id) => !UUID_RE.test(id))) throw notFound("Media");
          const rows = await db.select().from(media).where(inArray(media.id, ids));
          if (rows.length !== ids.length) throw notFound("Media");
          const owners = new Map(rows.map((r) => [`${r.ownerType}:${r.ownerId}`, r]));
          for (const r of owners.values()) await assertAccess(authUser, r.ownerType, r.ownerId);
          await db.transaction(async (tx) => {
            for (const [i, id] of ids.entries()) await tx.update(media).set({ sort: i }).where(eq(media.id, id));
          });
          for (const r of owners.values()) await syncOwnerMedia(r.ownerType, r.ownerId);
          return { ok: true };
        },
        { auth: true, body: t.Object({ ids: t.Array(t.String(), { maxItems: 500 }) }) },
      )

      .patch(
        "/:id",
        async ({ authUser, params, body }) => {
          const m = await loadMediaForUser(authUser, params.id);
          const row = await db.transaction(async (tx) => {
            if (body.isCover === true)
              await tx
                .update(media)
                .set({ isCover: false })
                .where(
                  and(
                    eq(media.ownerType, m.ownerType),
                    m.ownerId ? eq(media.ownerId, m.ownerId) : sql`${media.ownerId} IS NULL`,
                    eq(media.kind, m.kind),
                  ),
                );
            const [updated] = await tx
              .update(media)
              .set({
                tag: body.tag,
                title: body.title,
                caption: body.caption,
                isCover: body.isCover,
                posterUrl: body.posterUrl,
                sort: body.sort,
              })
              .where(eq(media.id, m.id))
              .returning();
            await syncOwnerMedia(m.ownerType, m.ownerId, tx);
            return updated;
          });
          await audit(authUser, "media.update", "media", m.id, body);
          return toMedia(row);
        },
        {
          auth: true,
          body: t.Object({
            tag: t.Optional(tagSchema),
            title: t.Optional(t.Nullable(t.String({ maxLength: 200 }))),
            caption: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            isCover: t.Optional(t.Boolean()),
            posterUrl: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            sort: t.Optional(t.Integer()),
          }),
        },
      )

      .delete(
        "/:id",
        async ({ authUser, params }) => {
          const m = await loadMediaForUser(authUser, params.id);
          await db.delete(media).where(eq(media.id, m.id));
          await syncOwnerMedia(m.ownerType, m.ownerId);
          // Only delete the stored object if no other media row points at it.
          const [{ n }] = await db
            .select({ n: sql<number>`count(*)`.mapWith(Number) })
            .from(media)
            .where(eq(media.s3Key, m.s3Key));
          if (n === 0) await deleteObject(m.s3Key);
          await audit(authUser, "media.delete", "media", m.id, { ownerType: m.ownerType, ownerId: m.ownerId, url: m.url });
          return { ok: true };
        },
        { auth: true },
      ),
  );
