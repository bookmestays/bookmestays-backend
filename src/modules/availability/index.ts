// GET /public/properties/:slug/availability → AvailabilityResponse (API_CONTRACT §3, Backend B)
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { amenities, media, properties, roomTypeAmenities } from "../../db/schema";
import { notFound } from "../../lib/errors";
import {
  allocateGuests,
  availableRooms,
  loadPricingContext,
  priceRooms,
  ratePlanPolicy,
  restrictionReason,
  validateStay,
  type Occupancy,
} from "../../services/pricing";

const dateStr = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const intStr = t.Optional(t.Numeric({ minimum: 0, maximum: 50 }));

export const mediaDto = (m: typeof media.$inferSelect) => ({
  id: m.id,
  ownerType: m.ownerType,
  ownerId: m.ownerId,
  kind: m.kind,
  url: m.url,
  posterUrl: m.posterUrl,
  hlsUrl: m.hlsUrl,
  title: m.title,
  caption: m.caption,
  tag: m.tag,
  durationSec: m.durationSec,
  width: m.width,
  height: m.height,
  sort: m.sort,
  isCover: m.isCover,
});

export const availabilityModule = new Elysia({ tags: ["Availability"] }).get(
  "/public/properties/:slug/availability",
  async ({ params, query }) => {
    const [property] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.slug, params.slug), eq(properties.status, "LIVE")));
    if (!property) throw notFound("Property");
    const { nights } = await validateStay(query.checkIn, query.checkOut);
    const adults = Math.max(1, query.adults ?? 2);
    const children = query.children ?? 0;
    const rooms = Math.max(1, query.rooms ?? 1);

    const ctx = await loadPricingContext(db, property.id, query.checkIn, query.checkOut, { publicOnly: true });
    const rtIds = ctx.roomTypes.map((r) => r.id);
    const [amenityRows, mediaRows] = rtIds.length
      ? await Promise.all([
          db
            .select({ roomTypeId: roomTypeAmenities.roomTypeId, a: amenities })
            .from(roomTypeAmenities)
            .innerJoin(amenities, eq(amenities.id, roomTypeAmenities.amenityId))
            .where(inArray(roomTypeAmenities.roomTypeId, rtIds))
            .orderBy(asc(amenities.sort)),
          db
            .select()
            .from(media)
            .where(and(eq(media.ownerType, "ROOM_TYPE"), inArray(media.ownerId, rtIds), ne(media.status, "FAILED")))
            .orderBy(asc(media.sort), asc(media.createdAt)),
        ])
      : [[], []];

    return {
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights,
      roomTypes: ctx.roomTypes.map((rt) => {
        const available = availableRooms(ctx, rt);
        const alloc = allocateGuests(Array.from({ length: rooms }, () => rt), adults, children);
        const occupancyError = typeof alloc === "string" ? `${alloc} (max ${rt.maxOccupancy} guests per room)` : null;
        // Show a base-occupancy price even when the party does not fit, so the card still has a price
        const occs: Occupancy[] =
          typeof alloc === "string"
            ? Array.from({ length: rooms }, () => ({ adults: Math.min(2, rt.maxAdults), children: 0 }))
            : alloc;
        return {
          id: rt.id,
          propertyId: rt.propertyId,
          name: rt.name,
          description: rt.description,
          maxAdults: rt.maxAdults,
          maxChildren: rt.maxChildren,
          maxOccupancy: rt.maxOccupancy,
          bedConfig: rt.bedConfig,
          sizeSqft: rt.sizeSqft,
          viewType: rt.viewType,
          basePrice: rt.basePrice,
          sort: rt.sort,
          amenities: amenityRows
            .filter((r) => r.roomTypeId === rt.id)
            .map(({ a }) => ({ id: a.id, code: a.code, name: a.name, icon: a.icon, category: a.category, scope: a.scope })),
          media: mediaRows.filter((m) => m.ownerId === rt.id).map(mediaDto),
          available,
          ratePlans: ctx.ratePlans
            .filter((rp) => rp.roomTypeId === rt.id)
            .map((rp) => {
              const priced = priceRooms(ctx, rp, occs);
              const totalPrice = Math.round(priced.amount / rooms);
              const reason =
                available === 0
                  ? "Sold out"
                  : available < rooms
                    ? `Only ${available} room${available > 1 ? "s" : ""} left`
                    : (occupancyError ?? restrictionReason(ctx, rp));
              return {
                ratePlanId: rp.id,
                name: rp.name,
                mealPlan: rp.mealPlan,
                inclusions: rp.inclusions,
                isRefundable: rp.isRefundable,
                cancellationPolicy: ratePlanPolicy(rp, ctx.property, ctx.partner),
                nightly: priced.nightly,
                totalPrice,
                avgNightly: Math.round(totalPrice / nights),
                taxesPerRoom: Math.round(priced.tax / rooms),
                available,
                bookable: !reason,
                ...(reason ? { reason } : {}),
              };
            }),
        };
      }),
    };
  },
  {
    params: t.Object({ slug: t.String() }),
    query: t.Object({ checkIn: dateStr, checkOut: dateStr, adults: intStr, children: intStr, rooms: intStr }),
  },
);
