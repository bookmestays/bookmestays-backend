// Shared TypeBox schemas for admin + partner catalog endpoints.
import { t } from "elysia";

export const lit = <T extends string>(values: readonly T[]) => t.Union(values.map((v) => t.Literal(v)));

export const PROPERTY_TYPE_VALUES = ["HOTEL", "VILLA", "FARMHOUSE", "HOMESTAY", "HERITAGE"] as const;
export const TRAVEL_TAG_VALUES = ["CORPORATE", "FAMILY", "COUPLES", "FRIENDS"] as const;
export const MEAL_PLAN_VALUES = ["EP", "CP", "MAP", "AP"] as const;

export const propertyTypeSchema = lit(PROPERTY_TYPE_VALUES);
export const travelTagSchema = lit(TRAVEL_TAG_VALUES);
export const commissionTypeSchema = lit(["PERCENT", "FLAT"] as const);
export const settlementCycleSchema = lit(["WEEKLY", "BIWEEKLY", "MONTHLY", "AFTER_CHECKOUT"] as const);
export const kycStatusSchema = lit(["PENDING", "SUBMITTED", "VERIFIED", "REJECTED"] as const);
export const mealPlanSchema = lit(MEAL_PLAN_VALUES);

export const dateStr = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
export const timeStr = t.String({ pattern: "^\\d{2}:\\d{2}$" });
export const money = t.Integer({ minimum: 0 });
export const nstr = (max = 5000) => t.Nullable(t.String({ maxLength: max }));

export const cancellationPolicySchema = t.Object({
  summary: t.String({ maxLength: 2000 }),
  rules: t.Array(
    t.Object({
      hoursBeforeCheckIn: t.Integer({ minimum: 0 }),
      refundPercent: t.Integer({ minimum: 0, maximum: 100 }),
    }),
    { maxItems: 10 },
  ),
});

export const seoSchema = t.Object({
  title: t.Optional(t.String({ maxLength: 200 })),
  description: t.Optional(t.String({ maxLength: 500 })),
  keywords: t.Optional(t.Array(t.String({ maxLength: 60 }), { maxItems: 30 })),
  ogImage: t.Optional(t.String({ maxLength: 2000 })),
});

export const pageQuery = {
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
};

/** Editable property content (partner + admin). */
export const propertyContentFields = {
  name: t.Optional(t.String({ minLength: 2, maxLength: 200 })),
  type: t.Optional(propertyTypeSchema),
  travelTags: t.Optional(t.Array(travelTagSchema, { maxItems: 4 })),
  starRating: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 7 }))),
  shortDescription: t.Optional(nstr(300)),
  description: t.Optional(nstr(20000)),
  highlights: t.Optional(t.Array(t.String({ maxLength: 200 }), { maxItems: 20 })),
  foodAndDining: t.Optional(nstr(10000)),
  cityId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  areaId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  address: t.Optional(nstr(1000)),
  pincode: t.Optional(nstr(10)),
  lat: t.Optional(t.Nullable(t.Number({ minimum: -90, maximum: 90 }))),
  lng: t.Optional(t.Nullable(t.Number({ minimum: -180, maximum: 180 }))),
  checkInTime: t.Optional(t.Nullable(timeStr)),
  checkOutTime: t.Optional(t.Nullable(timeStr)),
  cancellationPolicy: t.Optional(t.Nullable(cancellationPolicySchema)),
  houseRules: t.Optional(t.Array(t.String({ maxLength: 300 }), { maxItems: 40 })),
  terms: t.Optional(nstr(20000)),
  contactPhone: t.Optional(nstr(20)),
  contactEmail: t.Optional(nstr(255)),
};

export const roomTypeFields = {
  name: t.String({ minLength: 2, maxLength: 160 }),
  description: t.Optional(nstr(5000)),
  maxAdults: t.Integer({ minimum: 1, maximum: 20 }),
  maxChildren: t.Optional(t.Integer({ minimum: 0, maximum: 20 })),
  maxOccupancy: t.Optional(t.Integer({ minimum: 1, maximum: 40 })),
  bedConfig: t.Optional(nstr(160)),
  sizeSqft: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
  viewType: t.Optional(nstr(80)),
  totalRooms: t.Integer({ minimum: 0, maximum: 10000 }),
  basePrice: money,
  sort: t.Optional(t.Integer()),
};

export const ratePlanFields = {
  name: t.String({ minLength: 1, maxLength: 160 }),
  mealPlan: t.Optional(mealPlanSchema),
  inclusions: t.Optional(t.Array(t.String({ maxLength: 200 }), { maxItems: 30 })),
  isRefundable: t.Optional(t.Boolean()),
  cancellationPolicy: t.Optional(t.Nullable(cancellationPolicySchema)),
  basePrice: money,
  extraAdultPrice: t.Optional(money),
  extraChildPrice: t.Optional(money),
  isActive: t.Optional(t.Boolean()),
  sort: t.Optional(t.Integer()),
};

export const nearbyFields = {
  name: t.String({ minLength: 1, maxLength: 200 }),
  category: t.Optional(t.String({ maxLength: 60 })),
  description: t.Optional(nstr(5000)),
  distanceKm: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
  lat: t.Optional(t.Nullable(t.Number())),
  lng: t.Optional(t.Nullable(t.Number())),
  sort: t.Optional(t.Integer()),
};

/** Strips `undefined` so drizzle `.set()` only touches provided fields. */
export const defined = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
