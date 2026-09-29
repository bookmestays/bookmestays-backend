// Partner: profile (/partner/me), properties CRUD + submit, amenities, nearby places.
import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { bookings, media, nearbyPlaces, partners, properties, ratePlans, roomTypes } from "../../db/schema";
import { audit } from "../../lib/audit";
import { authPlugin } from "../../lib/auth";
import { conflict, forbidden, notFound, unprocessable } from "../../lib/errors";
import { encrypt } from "../../lib/utils";
import { createPropertyShell } from "../../services/catalog/accounts";
import { partnerProfile } from "../../services/catalog/partners";
import {
  buildPartnerPropertyRows,
  loadNearby,
  nearbyDto,
  partnerPropertyDetailById,
} from "../../services/catalog/property-detail";
import { setPropertyAmenities, validateLocation } from "../../services/catalog/property-ops";
import { deleteObject } from "../../services/catalog/storage";
import { defined, nearbyFields, nstr, propertyContentFields, propertyTypeSchema } from "../admin/schemas";
import { ownNearby, ownProperty } from "./scope";

const idParams = t.Object({ id: t.String() });
const KYC_FIELDS = ["gstin", "pan", "bankAccountName", "bankAccountNumber", "bankIfsc"] as const;

async function propertyHasBookings(propertyId: string) {
  const [{ n }] = await db.select({ n: count() }).from(bookings).where(eq(bookings.propertyId, propertyId));
  return n > 0;
}

export const partnerProperties = new Elysia({ name: "partner-properties" })
  .use(authPlugin)

  // ─── Profile ────────────────────────────────────────────────────────────────
  .get("/me", ({ partnerId }) => partnerProfile(partnerId), { partner: true })
  .patch(
    "/me",
    async ({ authUser, partnerId, body }) => {
      if (authUser.role !== "PARTNER_OWNER") throw forbidden("Only the account owner can edit the business profile");
      const current = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
      if (!current) throw notFound("Partner");
      const { bankAccountNumber, gstin, pan, bankIfsc, email, ...rest } = body;
      const cols: Record<string, unknown> = defined(rest);
      if (email !== undefined) cols.email = email.trim().toLowerCase();
      if (gstin !== undefined) cols.gstin = gstin ? gstin.toUpperCase() : null;
      if (pan !== undefined) cols.pan = pan ? pan.toUpperCase() : null;
      if (bankIfsc !== undefined) cols.bankIfsc = bankIfsc ? bankIfsc.toUpperCase() : null;
      if (bankAccountNumber !== undefined) {
        cols.bankAccountNumberEnc = bankAccountNumber ? encrypt(bankAccountNumber) : null;
        cols.bankAccountLast4 = bankAccountNumber ? bankAccountNumber.slice(-4) : null;
      }
      const kycChanged = KYC_FIELDS.some((k) => {
        if (body[k] === undefined) return false;
        if (k === "bankAccountNumber") return true;
        const colKey = k as "gstin" | "pan" | "bankAccountName" | "bankIfsc";
        return (cols[colKey] ?? null) !== (current[colKey] ?? null);
      });
      if (kycChanged) cols.kycStatus = "SUBMITTED";
      if (Object.keys(cols).length) await db.update(partners).set(cols).where(eq(partners.id, partnerId));
      await audit(authUser, "partner.profile_update", "partner", partnerId, {
        ...body,
        ...(bankAccountNumber !== undefined ? { bankAccountNumber: "••••" } : {}),
        kycResubmitted: kycChanged,
      });
      return partnerProfile(partnerId);
    },
    {
      partner: true,
      body: t.Object({
        contactName: t.Optional(t.String({ minLength: 2, maxLength: 160 })),
        email: t.Optional(t.String({ format: "email", maxLength: 255 })),
        phone: t.Optional(t.String({ minLength: 10, maxLength: 20 })),
        address: t.Optional(nstr(1000)),
        gstin: t.Optional(t.Nullable(t.String({ pattern: "^[0-9A-Za-z]{15}$" }))),
        pan: t.Optional(t.Nullable(t.String({ pattern: "^[A-Za-z]{5}[0-9]{4}[A-Za-z]$" }))),
        bankAccountName: t.Optional(nstr(200)),
        bankAccountNumber: t.Optional(t.Nullable(t.String({ pattern: "^[0-9]{6,20}$" }))),
        bankIfsc: t.Optional(t.Nullable(t.String({ pattern: "^[A-Za-z]{4}0[A-Za-z0-9]{6}$" }))),
      }),
    },
  )

  // ─── Properties ─────────────────────────────────────────────────────────────
  .get(
    "/properties",
    async ({ partnerId }) => {
      const rows = await db
        .select()
        .from(properties)
        .where(eq(properties.partnerId, partnerId))
        .orderBy(desc(properties.updatedAt));
      return buildPartnerPropertyRows(rows);
    },
    { partner: true },
  )

  .post(
    "/properties",
    async ({ authUser, partnerId, body }) => {
      const partner = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
      if (!partner) throw notFound("Partner");
      await validateLocation(body.cityId, body.areaId);
      const { amenityIds, ...content } = body;
      const row = await db.transaction(async (tx) => {
        const p = await createPropertyShell(tx, partner, { ...defined(content), name: body.name });
        if (amenityIds) await setPropertyAmenities(p.id, amenityIds, tx);
        return p;
      });
      await audit(authUser, "property.create", "property", row.id, { name: row.name });
      return partnerPropertyDetailById(row.id);
    },
    {
      partner: "content",
      body: t.Object({
        ...propertyContentFields,
        name: t.String({ minLength: 2, maxLength: 200 }),
        type: propertyTypeSchema,
        cityId: t.String({ format: "uuid" }),
        amenityIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 200 })),
      }),
    },
  )

  .get(
    "/properties/:id",
    async ({ partnerId, params }) => {
      const p = await ownProperty(partnerId, params.id);
      return partnerPropertyDetailById(p.id);
    },
    { partner: true, params: idParams },
  )

  .patch(
    "/properties/:id",
    async ({ authUser, partnerId, params, body }) => {
      const p = await ownProperty(partnerId, params.id);
      const cityId = body.cityId === undefined ? p.cityId : body.cityId;
      const areaId =
        body.areaId === undefined ? (body.cityId !== undefined && body.cityId !== p.cityId ? null : p.areaId) : body.areaId;
      await validateLocation(cityId, areaId);
      const { amenityIds, ...rest } = body;
      await db.transaction(async (tx) => {
        const cols = defined({ ...rest, areaId });
        if (Object.keys(cols).length) await tx.update(properties).set(cols).where(eq(properties.id, p.id));
        if (amenityIds) await setPropertyAmenities(p.id, amenityIds, tx);
      });
      // LIVE properties stay LIVE after content edits; every change is audit-logged for admin review.
      await audit(authUser, p.status === "LIVE" ? "property.live_content_update" : "property.update", "property", p.id, {
        status: p.status,
        changes: body,
      });
      return partnerPropertyDetailById(p.id);
    },
    {
      partner: "content",
      params: idParams,
      body: t.Object({
        ...propertyContentFields,
        amenityIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 200 })),
      }),
    },
  )

  .delete(
    "/properties/:id",
    async ({ authUser, partnerId, params }) => {
      const p = await ownProperty(partnerId, params.id);
      if (p.status !== "DRAFT" && p.status !== "REJECTED")
        throw conflict("Only draft or rejected properties can be deleted");
      if (await propertyHasBookings(p.id)) throw conflict("This property has bookings and cannot be deleted");
      const [rts, nearby] = await Promise.all([
        db.select({ id: roomTypes.id }).from(roomTypes).where(eq(roomTypes.propertyId, p.id)),
        db.select({ id: nearbyPlaces.id }).from(nearbyPlaces).where(eq(nearbyPlaces.propertyId, p.id)),
      ]);
      const ownerFilter = or(
        and(eq(media.ownerType, "PROPERTY"), eq(media.ownerId, p.id)),
        rts.length ? and(eq(media.ownerType, "ROOM_TYPE"), inArray(media.ownerId, rts.map((r) => r.id))) : undefined,
        nearby.length
          ? and(eq(media.ownerType, "NEARBY_PLACE"), inArray(media.ownerId, nearby.map((n) => n.id)))
          : undefined,
      );
      const removed = await db.transaction(async (tx) => {
        const m = await tx.delete(media).where(ownerFilter).returning({ s3Key: media.s3Key });
        await tx.delete(properties).where(eq(properties.id, p.id));
        return m;
      });
      for (const m of removed) void deleteObject(m.s3Key);
      await audit(authUser, "property.delete", "property", p.id, { name: p.name });
      return { ok: true };
    },
    { partner: "content", params: idParams },
  )

  .post(
    "/properties/:id/submit",
    async ({ authUser, partnerId, params }) => {
      const p = await ownProperty(partnerId, params.id);
      if (p.status !== "DRAFT" && p.status !== "REJECTED")
        throw conflict(p.status === "PENDING_REVIEW" ? "Property is already under review" : "Property is already published");
      const [[rtWithPlan], [{ images }]] = await Promise.all([
        db
          .select({ n: sql<number>`count(DISTINCT ${roomTypes.id})`.mapWith(Number) })
          .from(roomTypes)
          .innerJoin(ratePlans, and(eq(ratePlans.roomTypeId, roomTypes.id), eq(ratePlans.isActive, true)))
          .where(and(eq(roomTypes.propertyId, p.id), ne(roomTypes.status, "INACTIVE"))),
        db
          .select({ images: count() })
          .from(media)
          .where(and(eq(media.ownerType, "PROPERTY"), eq(media.ownerId, p.id), eq(media.kind, "IMAGE"))),
      ]);
      const missing: { field: string; message: string }[] = [];
      if (!rtWithPlan?.n) missing.push({ field: "roomTypes", message: "Add at least one room type with a rate plan" });
      if (images < 3) missing.push({ field: "media", message: `Upload at least 3 property photos (${images} so far)` });
      if (!p.address?.trim()) missing.push({ field: "address", message: "Add the property address" });
      if (!p.cityId) missing.push({ field: "cityId", message: "Choose the city" });
      if (!p.cancellationPolicy) missing.push({ field: "cancellationPolicy", message: "Set a cancellation policy" });
      if (missing.length)
        throw unprocessable(`Please complete: ${missing.map((m) => m.message).join("; ")}`, missing);
      await db.update(properties).set({ status: "PENDING_REVIEW" }).where(eq(properties.id, p.id));
      await audit(authUser, "property.submit", "property", p.id, { from: p.status });
      return partnerPropertyDetailById(p.id);
    },
    { partner: "content", params: idParams },
  )

  .put(
    "/properties/:id/amenities",
    async ({ authUser, partnerId, params, body }) => {
      const p = await ownProperty(partnerId, params.id);
      await db.transaction((tx) => setPropertyAmenities(p.id, body.amenityIds, tx));
      await audit(authUser, "property.amenities", "property", p.id, body);
      return partnerPropertyDetailById(p.id);
    },
    {
      partner: "content",
      params: idParams,
      body: t.Object({ amenityIds: t.Array(t.String({ format: "uuid" }), { maxItems: 200 }) }),
    },
  )

  // ─── Nearby places ──────────────────────────────────────────────────────────
  .get(
    "/properties/:id/nearby",
    async ({ partnerId, params }) => loadNearby((await ownProperty(partnerId, params.id)).id),
    { partner: true, params: idParams },
  )
  .post(
    "/properties/:id/nearby",
    async ({ authUser, partnerId, params, body }) => {
      const p = await ownProperty(partnerId, params.id);
      const [{ next }] = await db
        .select({ next: sql<number>`coalesce(max(${nearbyPlaces.sort}) + 1, 0)`.mapWith(Number) })
        .from(nearbyPlaces)
        .where(eq(nearbyPlaces.propertyId, p.id));
      const [row] = await db
        .insert(nearbyPlaces)
        .values({ sort: next, ...defined(body), propertyId: p.id })
        .returning();
      await audit(authUser, "nearby.create", "nearby_place", row.id, { propertyId: p.id, ...body });
      return nearbyDto(row.id);
    },
    { partner: "content", params: idParams, body: t.Object(nearbyFields) },
  )
  .patch(
    "/nearby/:id",
    async ({ authUser, partnerId, params, body }) => {
      const { nearby } = await ownNearby(partnerId, params.id);
      const cols = defined(body);
      if (Object.keys(cols).length) await db.update(nearbyPlaces).set(cols).where(eq(nearbyPlaces.id, nearby.id));
      await audit(authUser, "nearby.update", "nearby_place", nearby.id, body);
      return nearbyDto(nearby.id);
    },
    { partner: "content", params: idParams, body: t.Partial(t.Object(nearbyFields)) },
  )
  .delete(
    "/nearby/:id",
    async ({ authUser, partnerId, params }) => {
      const { nearby } = await ownNearby(partnerId, params.id);
      const removed = await db.transaction(async (tx) => {
        const m = await tx
          .delete(media)
          .where(and(eq(media.ownerType, "NEARBY_PLACE"), eq(media.ownerId, nearby.id)))
          .returning({ s3Key: media.s3Key });
        await tx.delete(nearbyPlaces).where(eq(nearbyPlaces.id, nearby.id));
        return m;
      });
      for (const m of removed) void deleteObject(m.s3Key);
      await audit(authUser, "nearby.delete", "nearby_place", nearby.id, { name: nearby.name });
      return { ok: true };
    },
    { partner: "content", params: idParams },
  );

