// Row → DTO mappers shared by the public, admin and partner catalog APIs.
// Shapes mirror bookmestays-frontend/src/lib/types.ts exactly.
import type {
  amenities,
  areas,
  cities,
  commissionRules,
  media,
  nearbyPlaces,
  ratePlans,
  roomTypes,
} from "../../db/schema";

type MediaRow = typeof media.$inferSelect;
type AmenityRow = typeof amenities.$inferSelect;
type CityRow = typeof cities.$inferSelect;
type AreaRow = typeof areas.$inferSelect;
type RatePlanRow = typeof ratePlans.$inferSelect;
type RoomTypeRow = typeof roomTypes.$inferSelect;
type NearbyRow = typeof nearbyPlaces.$inferSelect;
type CommissionRuleRow = typeof commissionRules.$inferSelect;

export const PROPERTY_TYPE_LABELS = {
  HOTEL: "Hotels",
  VILLA: "Villas",
  FARMHOUSE: "Farmhouses",
  HOMESTAY: "Homestays",
  HERITAGE: "Heritage Stays",
} as const;
export const TRAVEL_TAG_LABELS = {
  CORPORATE: "Corporate",
  FAMILY: "Family",
  COUPLES: "Couples",
  FRIENDS: "Friends",
} as const;
export type PropertyTypeValue = keyof typeof PROPERTY_TYPE_LABELS;
export type TravelTagValue = keyof typeof TRAVEL_TAG_LABELS;
export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_LABELS) as PropertyTypeValue[];
export const TRAVEL_TAGS = Object.keys(TRAVEL_TAG_LABELS) as TravelTagValue[];

export const iso = (d: Date | string | null | undefined) =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

export const toMedia = (m: MediaRow) => ({
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
export type MediaDto = ReturnType<typeof toMedia>;

export const toAmenity = (a: AmenityRow) => ({
  id: a.id,
  code: a.code,
  name: a.name,
  icon: a.icon,
  category: a.category,
  scope: a.scope,
});
export type AmenityDto = ReturnType<typeof toAmenity>;

export const toCityLite = (c: CityRow) => ({ id: c.id, name: c.name, slug: c.slug, state: c.state });
export type CityLiteDto = ReturnType<typeof toCityLite>;

export const toArea = (a: AreaRow) => ({
  id: a.id,
  cityId: a.cityId,
  name: a.name,
  slug: a.slug,
  description: a.description,
  isRecommended: a.isRecommended,
});
export type AreaDto = ReturnType<typeof toArea>;

export const toRatePlan = (r: RatePlanRow) => ({
  id: r.id,
  roomTypeId: r.roomTypeId,
  name: r.name,
  mealPlan: r.mealPlan,
  inclusions: r.inclusions,
  isRefundable: r.isRefundable,
  cancellationPolicy: r.cancellationPolicy ?? null,
  basePrice: r.basePrice,
  extraAdultPrice: r.extraAdultPrice,
  extraChildPrice: r.extraChildPrice,
  isActive: r.isActive,
  sort: r.sort,
});
export type RatePlanDto = ReturnType<typeof toRatePlan>;

export const toRoomTypeBase = (r: RoomTypeRow) => ({
  id: r.id,
  propertyId: r.propertyId,
  name: r.name,
  description: r.description,
  maxAdults: r.maxAdults,
  maxChildren: r.maxChildren,
  maxOccupancy: r.maxOccupancy,
  bedConfig: r.bedConfig,
  sizeSqft: r.sizeSqft,
  viewType: r.viewType,
  totalRooms: r.totalRooms,
  basePrice: r.basePrice,
  status: r.status,
  sort: r.sort,
});
export type RoomTypeDto = ReturnType<typeof toRoomTypeBase> & {
  amenities: AmenityDto[];
  media: MediaDto[];
  ratePlans: RatePlanDto[];
};

export const toNearbyBase = (n: NearbyRow) => ({
  id: n.id,
  name: n.name,
  category: n.category,
  description: n.description,
  distanceKm: n.distanceKm,
  lat: n.lat,
  lng: n.lng,
});
export type NearbyDto = ReturnType<typeof toNearbyBase> & { media: MediaDto[] };

export const toCommissionRule = (
  r: CommissionRuleRow,
  names: { propertyName?: string | null; roomTypeName?: string | null } = {},
) => ({
  id: r.id,
  partnerId: r.partnerId,
  propertyId: r.propertyId,
  propertyName: names.propertyName ?? null,
  roomTypeId: r.roomTypeId,
  roomTypeName: names.roomTypeName ?? null,
  type: r.type,
  value: r.value,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  notes: r.notes,
  createdAt: iso(r.createdAt)!,
});
export type CommissionRuleDto = ReturnType<typeof toCommissionRule>;

/** Groups rows by a key into a Map of arrays. */
export function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return map;
}

export const uniq = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x != null))];
