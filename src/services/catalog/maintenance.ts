// Keeps denormalised catalog fields in sync:
//  - properties.starting_price  = min basePrice of ACTIVE rate plans of ACTIVE room types
//  - properties.rating_avg/count = PUBLISHED reviews
//  - properties.cover_image_url / preview_video_url / preview_video_poster_url from PROPERTY media
//  - cover_image_url of experiences / cities / collections from their cover image
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db";
import { cities, collections, experiences, media, properties } from "../../db/schema";

type Exec = typeof db | Tx;

export async function recomputeStartingPrice(propertyId: string, exec: Exec = db) {
  await exec.execute(sql`
    UPDATE properties SET starting_price = (
      SELECT min(rp.base_price) FROM rate_plans rp
      JOIN room_types rt ON rt.id = rp.room_type_id
      WHERE rt.property_id = ${propertyId} AND rt.status = 'ACTIVE' AND rp.is_active
    ), updated_at = now()
    WHERE id = ${propertyId}
  `);
}

export async function recomputeRating(propertyId: string, exec: Exec = db) {
  await exec.execute(sql`
    UPDATE properties SET
      rating_avg = coalesce((SELECT round(avg(rating)::numeric, 1)::float8 FROM reviews WHERE property_id = ${propertyId} AND status = 'PUBLISHED'), 0),
      rating_count = (SELECT count(*)::int FROM reviews WHERE property_id = ${propertyId} AND status = 'PUBLISHED')
    WHERE id = ${propertyId}
  `);
}

/** Recomputes the denormalised cover / preview fields for the owner of some media. */
export async function syncOwnerMedia(ownerType: string, ownerId: string | null, exec: Exec = db) {
  if (!ownerId) return;
  const rows = await exec
    .select()
    .from(media)
    .where(and(eq(media.ownerType, ownerType as never), eq(media.ownerId, ownerId)))
    .orderBy(desc(media.isCover), asc(media.sort), asc(media.createdAt));
  const cover = rows.find((m) => m.kind === "IMAGE") ?? null;
  const video = rows.find((m) => m.kind === "VIDEO") ?? null;

  switch (ownerType) {
    case "PROPERTY":
      await exec
        .update(properties)
        .set({
          coverImageUrl: cover?.url ?? null,
          previewVideoUrl: video?.url ?? null,
          previewVideoPosterUrl: video ? (video.posterUrl ?? cover?.url ?? null) : null,
        })
        .where(eq(properties.id, ownerId));
      break;
    // For CMS entities the cover can also be typed in manually — only override when media exists.
    case "EXPERIENCE":
      if (cover) await exec.update(experiences).set({ coverImageUrl: cover.url }).where(eq(experiences.id, ownerId));
      break;
    case "CITY":
      if (cover) await exec.update(cities).set({ coverImageUrl: cover.url }).where(eq(cities.id, ownerId));
      break;
    case "COLLECTION":
      if (cover) await exec.update(collections).set({ coverImageUrl: cover.url }).where(eq(collections.id, ownerId));
      break;
  }
}
