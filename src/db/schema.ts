import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// All money is stored as integer paise (₹1 = 100) to avoid floating point errors.
const money = (name: string) => bigint(name, { mode: "number" });
const id = () => uuid("id").primaryKey().defaultRandom();
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ─── Enums ────────────────────────────────────────────────────────────────────

export const userRole = pgEnum("user_role", [
  "SUPER_ADMIN",
  "ADMIN_STAFF",
  "PARTNER_OWNER",
  "PARTNER_STAFF",
  "CUSTOMER",
]);
export const otpPurpose = pgEnum("otp_purpose", ["LOGIN", "VERIFY", "RESET_PASSWORD"]);

export const partnerStatus = pgEnum("partner_status", ["ACTIVE", "SUSPENDED", "INACTIVE"]);
export const kycStatus = pgEnum("kyc_status", ["PENDING", "SUBMITTED", "VERIFIED", "REJECTED"]);
export const settlementCycle = pgEnum("settlement_cycle", [
  "WEEKLY", // every settlement_day_of_week
  "BIWEEKLY",
  "MONTHLY", // on settlement_day_of_month
  "AFTER_CHECKOUT", // settlement_delay_days after each checkout (T+N)
]);
export const commissionType = pgEnum("commission_type", ["PERCENT", "FLAT"]);

export const propertyType = pgEnum("property_type", [
  "HOTEL",
  "VILLA",
  "FARMHOUSE",
  "HOMESTAY",
  "HERITAGE",
]);
export const travelTag = pgEnum("travel_tag", ["CORPORATE", "FAMILY", "COUPLES", "FRIENDS"]);
export const propertyStatus = pgEnum("property_status", [
  "DRAFT",
  "PENDING_REVIEW",
  "LIVE",
  "REJECTED",
  "SUSPENDED",
]);
export const roomTypeStatus = pgEnum("room_type_status", ["PENDING_APPROVAL", "ACTIVE", "INACTIVE"]);
export const mealPlan = pgEnum("meal_plan", ["EP", "CP", "MAP", "AP"]); // room only / breakfast / 2 meals / all meals
export const amenityScope = pgEnum("amenity_scope", ["PROPERTY", "ROOM", "BOTH"]);

export const mediaOwnerType = pgEnum("media_owner_type", [
  "PROPERTY",
  "ROOM_TYPE",
  "NEARBY_PLACE",
  "EXPERIENCE",
  "CITY",
  "COLLECTION",
  "BANNER",
]);
export const mediaKind = pgEnum("media_kind", ["IMAGE", "VIDEO"]);
export const mediaTag = pgEnum("media_tag", [
  "EXTERIOR",
  "ROOM_WALKTHROUGH",
  "ROOM",
  "BATHROOM",
  "VIEW",
  "COMMON_AREA",
  "POOL",
  "DINING",
  "SURROUNDINGS",
  "EXPERIENCE",
  "AMENITY",
  "OTHER",
]);
export const mediaStatus = pgEnum("media_status", ["UPLOADING", "PROCESSING", "READY", "FAILED"]);

export const bookingStatus = pgEnum("booking_status", [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CHECKED_IN",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "EXPIRED",
]);
export const paymentStatus = pgEnum("payment_status", [
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);
export const refundStatus = pgEnum("refund_status", ["PENDING", "PROCESSED", "FAILED"]);
export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "BOOKING_CREDIT", // room amount + room GST owed to partner
  "COMMISSION_DEBIT",
  "COMMISSION_GST_DEBIT",
  "TCS_DEBIT",
  "TDS_DEBIT",
  "REFUND_DEBIT",
  "CANCELLATION_FEE_CREDIT",
  "PAYOUT_DEBIT",
  "ADJUSTMENT",
]);
export const settlementStatus = pgEnum("settlement_status", [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "PAID",
  "FAILED",
  "ON_HOLD",
]);
export const transferStatus = pgEnum("transfer_status", [
  "CREATED",
  "ON_HOLD",
  "RELEASED",
  "SETTLED",
  "REVERSED",
  "FAILED",
]);

export const reviewStatus = pgEnum("review_status", ["PENDING", "PUBLISHED", "HIDDEN"]);
export const wishlistItemType = pgEnum("wishlist_item_type", ["PROPERTY", "EXPERIENCE"]);
export const couponType = pgEnum("coupon_type", ["PERCENT", "FLAT"]);
export const homeSectionType = pgEnum("home_section_type", [
  "RECOMMENDED",
  "PROPERTY_TYPES",
  "FEATURED",
  "VIDEO_DISCOVERY",
  "EXPERIENCES",
  "CITIES",
  "COLLECTIONS",
  "CITY_SPOTLIGHT",
  "WHY_BOOKMESTAYS",
]);

export const channelProvider = pgEnum("channel_provider", ["AXISROOMS", "EZEE", "STAAH", "SITEMINDER"]);
export const channelConnectionStatus = pgEnum("channel_connection_status", [
  "PENDING", // requested, waiting for mapping / CM activation
  "ACTIVE",
  "DISABLED",
  "ERROR",
]);
export const syncDirection = pgEnum("sync_direction", ["INBOUND", "OUTBOUND"]);
export const syncStatus = pgEnum("sync_status", ["PENDING", "SUCCESS", "FAILED", "RETRYING"]);

// ─── Users & auth ─────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    name: varchar("name", { length: 160 }),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    passwordHash: text("password_hash"),
    role: userRole("role").notNull().default("CUSTOMER"),
    avatarUrl: text("avatar_url"),
    emailVerified: boolean("email_verified").notNull().default(false),
    phoneVerified: boolean("phone_verified").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_phone_uq").on(t.phone),
    index("users_role_idx").on(t.role),
  ],
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: id(),
    target: varchar("target", { length: 255 }).notNull(), // phone or email
    codeHash: text("code_hash").notNull(),
    purpose: otpPurpose("purpose").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_target_idx").on(t.target, t.purpose)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: varchar("ip", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ─── Partners (hotel businesses) ──────────────────────────────────────────────

// Cancellation policy shape (stored as jsonb):
// { summary: string, rules: [{ hoursBeforeCheckIn: number, refundPercent: number }] }
// Rules are evaluated from the largest hoursBeforeCheckIn down; first match wins.
export type CancellationPolicy = {
  summary: string;
  rules: { hoursBeforeCheckIn: number; refundPercent: number }[];
};

export const partners = pgTable(
  "partners",
  {
    id: id(),
    legalName: varchar("legal_name", { length: 200 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    contactName: varchar("contact_name", { length: 160 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    address: text("address"),
    gstin: varchar("gstin", { length: 15 }),
    pan: varchar("pan", { length: 10 }),
    // Bank details — account number stored encrypted, last4 kept for display
    bankAccountName: varchar("bank_account_name", { length: 200 }),
    bankAccountNumberEnc: text("bank_account_number_enc"),
    bankAccountLast4: varchar("bank_account_last4", { length: 4 }),
    bankIfsc: varchar("bank_ifsc", { length: 11 }),
    kycStatus: kycStatus("kyc_status").notNull().default("PENDING"),
    kycNotes: text("kyc_notes"),
    razorpayLinkedAccountId: varchar("razorpay_linked_account_id", { length: 64 }),
    razorpayxContactId: varchar("razorpayx_contact_id", { length: 64 }),
    razorpayxFundAccountId: varchar("razorpayx_fund_account_id", { length: 64 }),
    // Settlement settings — set by admin when creating the partner
    settlementCycle: settlementCycle("settlement_cycle").notNull().default("WEEKLY"),
    settlementDayOfWeek: integer("settlement_day_of_week").default(1), // 0=Sun … 6=Sat
    settlementDayOfMonth: integer("settlement_day_of_month").default(1),
    settlementDelayDays: integer("settlement_delay_days").notNull().default(3), // min days after checkout
    // Default commission — overridden per property / room type via commission_rules
    defaultCommissionType: commissionType("default_commission_type").notNull().default("PERCENT"),
    defaultCommissionValue: integer("default_commission_value").notNull().default(1500), // basis points for PERCENT (1500 = 15%), paise for FLAT
    // Default policies (a property can override)
    defaultCancellationPolicy: jsonb("default_cancellation_policy").$type<CancellationPolicy>(),
    defaultTerms: text("default_terms"),
    status: partnerStatus("status").notNull().default("ACTIVE"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("partners_status_idx").on(t.status)],
);

export const partnerUsers = pgTable(
  "partner_users",
  {
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // permissions for staff, e.g. ["bookings","inventory","content","payouts"]; owner has all
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.partnerId, t.userId] })],
);

// ─── Geography ────────────────────────────────────────────────────────────────

export type Seo = { title?: string; description?: string; keywords?: string[]; ogImage?: string };

export const cities = pgTable("cities", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 140 }).notNull().unique(),
  state: varchar("state", { length: 120 }),
  country: varchar("country", { length: 80 }).notNull().default("India"),
  intro: text("intro"),
  travelInfo: text("travel_info"),
  foodGuide: text("food_guide"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  coverImageUrl: text("cover_image_url"),
  isFeatured: boolean("is_featured").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  seo: jsonb("seo").$type<Seo>(),
  ...timestamps,
});

export const areas = pgTable(
  "areas",
  {
    id: id(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 140 }).notNull(),
    description: text("description"),
    isRecommended: boolean("is_recommended").notNull().default(false),
  },
  (t) => [uniqueIndex("areas_city_slug_uq").on(t.cityId, t.slug)],
);

// ─── Properties ───────────────────────────────────────────────────────────────

export const properties = pgTable(
  "properties",
  {
    id: id(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 220 }).notNull().unique(),
    type: propertyType("type").notNull().default("HOTEL"),
    travelTags: travelTag("travel_tags").array().notNull().default(sql`'{}'`),
    starRating: integer("star_rating"),
    shortDescription: varchar("short_description", { length: 300 }),
    description: text("description"),
    highlights: text("highlights").array().notNull().default(sql`'{}'::text[]`),
    foodAndDining: text("food_and_dining"),
    cityId: uuid("city_id").references(() => cities.id),
    areaId: uuid("area_id").references(() => areas.id),
    address: text("address"),
    pincode: varchar("pincode", { length: 10 }),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    checkInTime: varchar("check_in_time", { length: 5 }).default("14:00"),
    checkOutTime: varchar("check_out_time", { length: 5 }).default("11:00"),
    cancellationPolicy: jsonb("cancellation_policy").$type<CancellationPolicy>(),
    houseRules: text("house_rules").array().notNull().default(sql`'{}'::text[]`),
    terms: text("terms"),
    contactPhone: varchar("contact_phone", { length: 20 }),
    contactEmail: varchar("contact_email", { length: 255 }),
    status: propertyStatus("status").notNull().default("DRAFT"),
    reviewNotes: text("review_notes"),
    // Denormalised for fast listing / sorting
    startingPrice: money("starting_price"),
    ratingAvg: doublePrecision("rating_avg").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    coverImageUrl: text("cover_image_url"),
    previewVideoUrl: text("preview_video_url"), // short clip used on cards
    previewVideoPosterUrl: text("preview_video_poster_url"),
    // Popularity, recomputed from bookings (see services/catalog/popularity.ts)
    completedBookings: integer("completed_bookings").notNull().default(0),
    cancelledBookings: integer("cancelled_bookings").notNull().default(0),
    popularityScore: doublePrecision("popularity_score").notNull().default(0),
    popularityUpdatedAt: timestamp("popularity_updated_at", { withTimezone: true }),
    // Admin curation (curationRank > 0 pins a property above the popularity order)
    isFeatured: boolean("is_featured").notNull().default(false),
    isRecommended: boolean("is_recommended").notNull().default(false),
    curationRank: integer("curation_rank").notNull().default(0),
    // When connected to a channel manager, ARI (rates/availability/inventory) is read-only in our panel
    channelManaged: boolean("channel_managed").notNull().default(false),
    seo: jsonb("seo").$type<Seo>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("properties_partner_idx").on(t.partnerId),
    index("properties_city_status_idx").on(t.cityId, t.status),
    index("properties_type_idx").on(t.type),
    index("properties_popularity_idx").on(t.status, t.popularityScore),
  ],
);

export const amenities = pgTable("amenities", {
  id: id(),
  code: varchar("code", { length: 60 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  icon: varchar("icon", { length: 60 }),
  category: varchar("category", { length: 60 }).notNull().default("General"),
  scope: amenityScope("scope").notNull().default("BOTH"),
  sort: integer("sort").notNull().default(0),
});

export const propertyAmenities = pgTable(
  "property_amenities",
  {
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    amenityId: uuid("amenity_id")
      .notNull()
      .references(() => amenities.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.amenityId] })],
);

export const nearbyPlaces = pgTable(
  "nearby_places",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    category: varchar("category", { length: 60 }).notNull().default("ATTRACTION"), // ATTRACTION, TRANSPORT, FOOD, SHOPPING, HOSPITAL…
    description: text("description"),
    distanceKm: doublePrecision("distance_km"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("nearby_property_idx").on(t.propertyId)],
);

export const roomTypes = pgTable(
  "room_types",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    maxAdults: integer("max_adults").notNull().default(2),
    maxChildren: integer("max_children").notNull().default(0),
    maxOccupancy: integer("max_occupancy").notNull().default(2),
    bedConfig: varchar("bed_config", { length: 160 }), // "1 King bed" / "2 Twin beds"
    sizeSqft: integer("size_sqft"),
    viewType: varchar("view_type", { length: 80 }),
    totalRooms: integer("total_rooms").notNull().default(1), // default daily inventory
    basePrice: money("base_price").notNull(), // default nightly price (paise)
    status: roomTypeStatus("status").notNull().default("PENDING_APPROVAL"),
    sort: integer("sort").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("room_types_property_idx").on(t.propertyId)],
);

export const roomTypeAmenities = pgTable(
  "room_type_amenities",
  {
    roomTypeId: uuid("room_type_id")
      .notNull()
      .references(() => roomTypes.id, { onDelete: "cascade" }),
    amenityId: uuid("amenity_id")
      .notNull()
      .references(() => amenities.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roomTypeId, t.amenityId] })],
);

export const ratePlans = pgTable(
  "rate_plans",
  {
    id: id(),
    roomTypeId: uuid("room_type_id")
      .notNull()
      .references(() => roomTypes.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(), // "Room only", "With breakfast"
    mealPlan: mealPlan("meal_plan").notNull().default("EP"),
    inclusions: text("inclusions").array().notNull().default(sql`'{}'::text[]`),
    isRefundable: boolean("is_refundable").notNull().default(true),
    // Overrides the property cancellation policy when set
    cancellationPolicy: jsonb("cancellation_policy").$type<CancellationPolicy>(),
    // Default nightly price for this plan; per-date prices live in `rates`
    basePrice: money("base_price").notNull(),
    extraAdultPrice: money("extra_adult_price").notNull().default(0),
    extraChildPrice: money("extra_child_price").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("rate_plans_room_type_idx").on(t.roomTypeId)],
);

// Daily inventory per room type. available = total - sold - held - blocked.
export const inventory = pgTable(
  "inventory",
  {
    roomTypeId: uuid("room_type_id")
      .notNull()
      .references(() => roomTypes.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    total: integer("total").notNull(),
    sold: integer("sold").notNull().default(0), // confirmed bookings
    held: integer("held").notNull().default(0), // pending-payment holds
    blocked: integer("blocked").notNull().default(0), // hotel closed rooms manually
    stopSell: boolean("stop_sell").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 40 }), // "PARTNER" | "CM:STAAH" | "SYSTEM"
  },
  (t) => [primaryKey({ columns: [t.roomTypeId, t.date] })],
);

// Daily price + restrictions per rate plan.
export const rates = pgTable(
  "rates",
  {
    ratePlanId: uuid("rate_plan_id")
      .notNull()
      .references(() => ratePlans.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    price: money("price").notNull(),
    minStay: integer("min_stay").notNull().default(1),
    maxStay: integer("max_stay"),
    closedToArrival: boolean("closed_to_arrival").notNull().default(false),
    closedToDeparture: boolean("closed_to_departure").notNull().default(false),
    stopSell: boolean("stop_sell").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 40 }),
  },
  (t) => [primaryKey({ columns: [t.ratePlanId, t.date] })],
);

// Commission rules — set by admin. roomTypeId null = property-wide default.
export const commissionRules = pgTable(
  "commission_rules",
  {
    id: id(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    roomTypeId: uuid("room_type_id").references(() => roomTypes.id, { onDelete: "cascade" }),
    type: commissionType("type").notNull().default("PERCENT"),
    value: integer("value").notNull(), // basis points for PERCENT, paise per room-night for FLAT
    effectiveFrom: date("effective_from").notNull().default(sql`CURRENT_DATE`),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("commission_lookup_idx").on(t.partnerId, t.propertyId, t.roomTypeId)],
);

// ─── Media (S3) ───────────────────────────────────────────────────────────────

export const media = pgTable(
  "media",
  {
    id: id(),
    ownerType: mediaOwnerType("owner_type").notNull(),
    ownerId: uuid("owner_id"), // null allowed for BANNER
    kind: mediaKind("kind").notNull(),
    s3Key: text("s3_key").notNull(),
    url: text("url").notNull(),
    posterUrl: text("poster_url"), // video poster/thumbnail
    hlsUrl: text("hls_url"), // adaptive stream once transcoded
    mimeType: varchar("mime_type", { length: 100 }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    durationSec: integer("duration_sec"),
    title: varchar("title", { length: 200 }),
    caption: text("caption"),
    tag: mediaTag("tag").notNull().default("OTHER"),
    sort: integer("sort").notNull().default(0),
    isCover: boolean("is_cover").notNull().default(false),
    status: mediaStatus("status").notNull().default("UPLOADING"),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("media_owner_idx").on(t.ownerType, t.ownerId)],
);

// Hero video slider on the homepage — uploaded by admin
export const banners = pgTable("banners", {
  id: id(),
  title: varchar("title", { length: 200 }).notNull(),
  subtitle: text("subtitle"),
  videoUrl: text("video_url"),
  hlsUrl: text("hls_url"),
  posterUrl: text("poster_url"),
  ctaLabel: varchar("cta_label", { length: 60 }),
  ctaUrl: text("cta_url"),
  propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
  sort: integer("sort").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  ...timestamps,
});

// ─── Experiences, collections, CMS ────────────────────────────────────────────

export const experiences = pgTable(
  "experiences",
  {
    id: id(),
    title: varchar("title", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 220 }).notNull().unique(),
    cityId: uuid("city_id").references(() => cities.id),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    shortDescription: varchar("short_description", { length: 300 }),
    story: text("story"),
    location: text("location"),
    meetingPoint: text("meeting_point"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    durationMinutes: integer("duration_minutes"),
    price: money("price"), // per person
    suitableFor: text("suitable_for").array().notNull().default(sql`'{}'::text[]`),
    included: text("included").array().notNull().default(sql`'{}'::text[]`),
    excluded: text("excluded").array().notNull().default(sql`'{}'::text[]`),
    hostName: varchar("host_name", { length: 160 }),
    hostInfo: text("host_info"),
    availabilityNote: text("availability_note"),
    isBookable: boolean("is_bookable").notNull().default(false), // V1: display only
    isActive: boolean("is_active").notNull().default(true),
    coverImageUrl: text("cover_image_url"),
    ratingAvg: doublePrecision("rating_avg").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    sort: integer("sort").notNull().default(0),
    seo: jsonb("seo").$type<Seo>(),
    ...timestamps,
  },
  (t) => [index("experiences_city_idx").on(t.cityId)],
);

export const collections = pgTable("collections", {
  id: id(),
  title: varchar("title", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 180 }).notNull().unique(),
  description: text("description"),
  cityId: uuid("city_id").references(() => cities.id, { onDelete: "set null" }),
  coverImageUrl: text("cover_image_url"),
  sort: integer("sort").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  seo: jsonb("seo").$type<Seo>(),
  ...timestamps,
});

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.propertyId] })],
);

// Homepage sections, ordered and toggled by admin. `config` depends on type,
// e.g. { propertyIds: [...] } for FEATURED, { cityId } for CITY_SPOTLIGHT, { limit } etc.
export const homeSections = pgTable("home_sections", {
  id: id(),
  type: homeSectionType("type").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  subtitle: text("subtitle"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  sort: integer("sort").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

// Key/value site settings (support phone, social links, tax config…)
export const siteSettings = pgTable("site_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Bookings & payments ──────────────────────────────────────────────────────

export const coupons = pgTable("coupons", {
  id: id(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  description: text("description"),
  type: couponType("type").notNull(),
  value: integer("value").notNull(), // basis points or paise
  maxDiscount: money("max_discount"),
  minBookingAmount: money("min_booking_amount").notNull().default(0),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  usageLimit: integer("usage_limit"),
  perUserLimit: integer("per_user_limit").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
  // Who bears the discount: PLATFORM reduces our commission, PARTNER reduces hotel payout
  fundedBy: varchar("funded_by", { length: 10 }).notNull().default("PLATFORM"),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    code: varchar("code", { length: 20 }).notNull().unique(), // e.g. BMS7K2Q9XA
    userId: uuid("user_id").references(() => users.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    checkIn: date("check_in").notNull(),
    checkOut: date("check_out").notNull(),
    nights: integer("nights").notNull(),
    adults: integer("adults").notNull(),
    children: integer("children").notNull().default(0),
    guestName: varchar("guest_name", { length: 160 }).notNull(),
    guestEmail: varchar("guest_email", { length: 255 }).notNull(),
    guestPhone: varchar("guest_phone", { length: 20 }).notNull(),
    specialRequests: text("special_requests"),
    status: bookingStatus("status").notNull().default("PENDING_PAYMENT"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    // Price breakdown (paise)
    roomAmount: money("room_amount").notNull(), // sum of nightly prices
    roomTax: money("room_tax").notNull().default(0), // GST on accommodation
    addonsAmount: money("addons_amount").notNull().default(0),
    discountAmount: money("discount_amount").notNull().default(0),
    totalAmount: money("total_amount").notNull(), // what guest pays
    // Platform economics (snapshot at booking time)
    commissionAmount: money("commission_amount").notNull().default(0),
    commissionTax: money("commission_tax").notNull().default(0), // GST on commission
    tcsAmount: money("tcs_amount").notNull().default(0),
    tdsAmount: money("tds_amount").notNull().default(0),
    partnerPayout: money("partner_payout").notNull().default(0),
    couponId: uuid("coupon_id").references(() => coupons.id),
    cancellationPolicy: jsonb("cancellation_policy").$type<CancellationPolicy>(),
    termsSnapshot: text("terms_snapshot"),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    source: varchar("source", { length: 30 }).notNull().default("WEB"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: varchar("cancelled_by", { length: 20 }), // GUEST | PARTNER | ADMIN | SYSTEM
    cancelReason: text("cancel_reason"),
    refundAmount: money("refund_amount").notNull().default(0),
    settlementId: uuid("settlement_id"),
    settlementDueDate: date("settlement_due_date"),
    channelSyncStatus: syncStatus("channel_sync_status"),
    ...timestamps,
  },
  (t) => [
    index("bookings_user_idx").on(t.userId),
    index("bookings_property_idx").on(t.propertyId, t.checkIn),
    index("bookings_partner_status_idx").on(t.partnerId, t.status),
    index("bookings_hold_idx").on(t.status, t.holdExpiresAt),
    index("bookings_settlement_idx").on(t.partnerId, t.settlementDueDate),
  ],
);

export const bookingRooms = pgTable(
  "booking_rooms",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    roomTypeId: uuid("room_type_id")
      .notNull()
      .references(() => roomTypes.id),
    ratePlanId: uuid("rate_plan_id")
      .notNull()
      .references(() => ratePlans.id),
    roomTypeName: varchar("room_type_name", { length: 160 }).notNull(),
    ratePlanName: varchar("rate_plan_name", { length: 160 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    adults: integer("adults").notNull().default(2),
    children: integer("children").notNull().default(0),
    nightlyPrices: jsonb("nightly_prices").$type<{ date: string; price: number }[]>().notNull(),
    amount: money("amount").notNull(),
    commissionType: commissionType("commission_type").notNull(),
    commissionValue: integer("commission_value").notNull(),
    commissionAmount: money("commission_amount").notNull(),
  },
  (t) => [index("booking_rooms_booking_idx").on(t.bookingId)],
);

export const bookingAddons = pgTable("booking_addons", {
  id: id(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  experienceId: uuid("experience_id").references(() => experiences.id),
  title: varchar("title", { length: 200 }).notNull(),
  date: date("date"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: money("unit_price").notNull(),
  amount: money("amount").notNull(),
});

export const payments = pgTable(
  "payments",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 20 }).notNull().default("RAZORPAY"),
    providerOrderId: varchar("provider_order_id", { length: 64 }).unique(),
    providerPaymentId: varchar("provider_payment_id", { length: 64 }).unique(),
    amount: money("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    status: paymentStatus("status").notNull().default("CREATED"),
    method: varchar("method", { length: 30 }),
    errorCode: varchar("error_code", { length: 80 }),
    errorDescription: text("error_description"),
    raw: jsonb("raw"),
    ...timestamps,
  },
  (t) => [index("payments_booking_idx").on(t.bookingId)],
);

// Razorpay Route transfer from a payment to the partner's linked account (held until settlement)
export const paymentTransfers = pgTable(
  "payment_transfers",
  {
    id: id(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    providerTransferId: varchar("provider_transfer_id", { length: 64 }).unique(),
    amount: money("amount").notNull(),
    // Portion reversed back to us when the guest was refunded (Razorpay `reverse_all`)
    amountReversed: money("amount_reversed").notNull().default(0),
    onHoldUntil: date("on_hold_until"),
    status: transferStatus("status").notNull().default("CREATED"),
    settlementId: uuid("settlement_id"),
    raw: jsonb("raw"),
    ...timestamps,
  },
  (t) => [index("transfers_partner_idx").on(t.partnerId, t.status)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    amount: money("amount").notNull(),
    providerRefundId: varchar("provider_refund_id", { length: 64 }).unique(),
    status: refundStatus("status").notNull().default("PENDING"),
    reason: text("reason"),
    initiatedBy: uuid("initiated_by").references(() => users.id),
    raw: jsonb("raw"),
    ...timestamps,
  },
  (t) => [index("refunds_booking_idx").on(t.bookingId)],
);

// Date / room changes of a confirmed booking. A change that costs more waits in PENDING_PAYMENT (holding the
// extra inventory it needs, see `heldInventory`) until the supplementary payment is verified; everything else
// is APPLIED straight away. `quote` snapshots the re-priced economics that get written onto the booking.
export const modificationStatus = pgEnum("booking_modification_status", [
  "PENDING_PAYMENT",
  "APPLIED",
  "CANCELLED",
  "EXPIRED",
]);
export type ModificationRoom = { roomTypeId: string; ratePlanId: string; quantity: number };
export type ModificationQuoteSnapshot = {
  nights: number;
  roomAmount: number;
  roomTax: number;
  addonsAmount: number;
  discountAmount: number;
  totalAmount: number;
  commissionAmount: number;
  commissionTax: number;
  tcsAmount: number;
  tdsAmount: number;
  partnerPayout: number;
  cancellationPolicy: CancellationPolicy;
  lines: {
    roomTypeId: string;
    ratePlanId: string;
    roomTypeName: string;
    ratePlanName: string;
    quantity: number;
    adults: number;
    children: number;
    nightly: { date: string; price: number }[];
    amount: number;
    commissionType: "PERCENT" | "FLAT";
    commissionValue: number;
    commissionAmount: number;
  }[];
};
export const bookingModifications = pgTable(
  "booking_modifications",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    status: modificationStatus("status").notNull(),
    requestedBy: varchar("requested_by", { length: 20 }).notNull(), // GUEST | ADMIN
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    // Before / after
    fromCheckIn: date("from_check_in").notNull(),
    fromCheckOut: date("from_check_out").notNull(),
    fromAdults: integer("from_adults").notNull(),
    fromChildren: integer("from_children").notNull(),
    fromRooms: jsonb("from_rooms").$type<ModificationRoom[]>().notNull(),
    fromTotal: money("from_total").notNull(),
    fromPayout: money("from_payout").notNull(),
    checkIn: date("check_in").notNull(),
    checkOut: date("check_out").notNull(),
    adults: integer("adults").notNull(),
    children: integer("children").notNull().default(0),
    rooms: jsonb("rooms").$type<ModificationRoom[]>().notNull(),
    quote: jsonb("quote").$type<ModificationQuoteSnapshot>().notNull(),
    // new total − old total (signed paise); PAY > 0, REFUND < 0
    difference: money("difference").notNull(),
    action: varchar("action", { length: 10 }).notNull(), // PAY | REFUND | NONE
    waived: boolean("waived").notNull().default(false),
    // Extra rooms held while waiting for payment: [{ roomTypeId, date, qty }]
    heldInventory: jsonb("held_inventory").$type<{ roomTypeId: string; date: string; qty: number }[]>(),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    paymentId: uuid("payment_id").references(() => payments.id),
    refundId: uuid("refund_id").references(() => refunds.id),
    reason: text("reason"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("booking_modifications_booking_idx").on(t.bookingId, t.status),
    index("booking_modifications_hold_idx").on(t.status, t.holdExpiresAt),
    index("booking_modifications_payment_idx").on(t.paymentId),
  ],
);

// Every money movement relating to a partner. Balance = sum(amount) (positive = we owe partner).
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    bookingId: uuid("booking_id").references(() => bookings.id),
    settlementId: uuid("settlement_id"),
    type: ledgerEntryType("type").notNull(),
    amount: money("amount").notNull(), // signed paise
    description: text("description"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_partner_idx").on(t.partnerId, t.createdAt),
    index("ledger_settlement_idx").on(t.settlementId),
  ],
);

export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    scheduledFor: date("scheduled_for").notNull(),
    bookingsCount: integer("bookings_count").notNull().default(0),
    grossAmount: money("gross_amount").notNull().default(0), // room + room tax
    commissionAmount: money("commission_amount").notNull().default(0),
    commissionTax: money("commission_tax").notNull().default(0),
    tcsAmount: money("tcs_amount").notNull().default(0),
    tdsAmount: money("tds_amount").notNull().default(0),
    refundAdjustments: money("refund_adjustments").notNull().default(0),
    otherAdjustments: money("other_adjustments").notNull().default(0),
    netPayable: money("net_payable").notNull().default(0),
    status: settlementStatus("status").notNull().default("PENDING"),
    method: varchar("method", { length: 20 }), // ROUTE_RELEASE | RAZORPAYX_PAYOUT | MANUAL
    utr: varchar("utr", { length: 60 }),
    failureReason: text("failure_reason"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("settlements_partner_idx").on(t.partnerId, t.status)],
);

export const payouts = pgTable("payouts", {
  id: id(),
  settlementId: uuid("settlement_id").references(() => settlements.id),
  partnerId: uuid("partner_id")
    .notNull()
    .references(() => partners.id),
  provider: varchar("provider", { length: 20 }).notNull().default("RAZORPAYX"),
  providerPayoutId: varchar("provider_payout_id", { length: 64 }).unique(),
  amount: money("amount").notNull(),
  mode: varchar("mode", { length: 10 }).notNull().default("IMPS"), // IMPS/NEFT/RTGS
  status: varchar("status", { length: 20 }).notNull().default("QUEUED"),
  utr: varchar("utr", { length: 60 }),
  failureReason: text("failure_reason"),
  raw: jsonb("raw"),
  ...timestamps,
});

// Idempotency for inbound webhooks
export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  provider: varchar("provider", { length: 20 }).notNull(),
  eventId: varchar("event_id", { length: 120 }).notNull().unique(),
  type: varchar("type", { length: 80 }).notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Guest engagement ─────────────────────────────────────────────────────────

export const wishlists = pgTable(
  "wishlists",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemType: wishlistItemType("item_type").notNull(),
    itemId: uuid("item_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemType, t.itemId] })],
);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .references(() => bookings.id)
      .unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(), // 1-5
    title: varchar("title", { length: 200 }),
    body: text("body"),
    status: reviewStatus("status").notNull().default("PENDING"),
    partnerReply: text("partner_reply"),
    partnerRepliedAt: timestamp("partner_replied_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("reviews_property_idx").on(t.propertyId, t.status)],
);

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: id(),
    name: varchar("name", { length: 80 }).notNull(),
    userId: uuid("user_id"),
    sessionId: varchar("session_id", { length: 80 }),
    props: jsonb("props"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("analytics_name_time_idx").on(t.name, t.createdAt)],
);

// ─── Channel managers ─────────────────────────────────────────────────────────

// One active connection per property (a hotel uses exactly one channel manager).
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    provider: channelProvider("provider").notNull(),
    // The hotel's ID inside the channel manager (they send it in every message)
    cmPropertyCode: varchar("cm_property_code", { length: 80 }).notNull(),
    // Optional per-hotel credentials, encrypted JSON string
    credentialsEnc: text("credentials_enc"),
    status: channelConnectionStatus("status").notNull().default("PENDING"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastError: text("last_error"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("channel_conn_property_uq").on(t.propertyId),
    uniqueIndex("channel_conn_provider_code_uq").on(t.provider, t.cmPropertyCode),
  ],
);

export const channelMappings = pgTable(
  "channel_mappings",
  {
    id: id(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => channelConnections.id, { onDelete: "cascade" }),
    roomTypeId: uuid("room_type_id")
      .notNull()
      .references(() => roomTypes.id, { onDelete: "cascade" }),
    ratePlanId: uuid("rate_plan_id").references(() => ratePlans.id, { onDelete: "cascade" }),
    cmRoomCode: varchar("cm_room_code", { length: 80 }).notNull(),
    cmRateCode: varchar("cm_rate_code", { length: 80 }),
  },
  (t) => [
    uniqueIndex("channel_map_uq").on(t.connectionId, t.cmRoomCode, t.cmRateCode),
    index("channel_map_room_idx").on(t.roomTypeId),
  ],
);

export const channelSyncLogs = pgTable(
  "channel_sync_logs",
  {
    id: id(),
    connectionId: uuid("connection_id").references(() => channelConnections.id, { onDelete: "set null" }),
    provider: channelProvider("provider").notNull(),
    direction: syncDirection("direction").notNull(),
    messageType: varchar("message_type", { length: 80 }).notNull(), // OTA_HotelAvailNotifRQ, ReservationPush …
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    requestPayload: text("request_payload"),
    responsePayload: text("response_payload"),
    status: syncStatus("status").notNull().default("PENDING"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sync_logs_conn_idx").on(t.connectionId, t.createdAt),
    index("sync_logs_retry_idx").on(t.status, t.nextRetryAt),
  ],
);

// ─── Audit ────────────────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorRole: varchar("actor_role", { length: 20 }),
    action: varchar("action", { length: 80 }).notNull(), // partner.create, property.approve …
    entity: varchar("entity", { length: 60 }).notNull(),
    entityId: varchar("entity_id", { length: 80 }),
    data: jsonb("data"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_entity_idx").on(t.entity, t.entityId)],
);
