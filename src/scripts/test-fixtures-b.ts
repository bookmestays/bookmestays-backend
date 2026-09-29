// Minimal fixtures for testing Backend B end-to-end (bookings, payments, settlements, channel managers).
// Idempotent: re-running reuses existing rows. Run: bun run src/scripts/test-fixtures-b.ts
// Prints the ids as JSON (used by the curl test walkthrough in docs/CHANNEL_MANAGERS.md).
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  cities,
  commissionRules,
  coupons,
  partners,
  partnerUsers,
  properties,
  ratePlans,
  roomTypes,
  users,
} from "../db/schema";
import { encrypt } from "../lib/utils";

const PASSWORD = "Test@12345";

async function user(email: string, name: string, role: "PARTNER_OWNER" | "CUSTOMER", phone: string) {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  if (u) return u;
  const [created] = await db
    .insert(users)
    .values({ email, name, phone, role, passwordHash: await Bun.password.hash(PASSWORD), emailVerified: true })
    .returning();
  return created;
}

const policy = {
  summary: "Free cancellation up to 3 days before check-in, 50% refund up to 24 hours before, no refund after.",
  rules: [
    { hoursBeforeCheckIn: 72, refundPercent: 100 },
    { hoursBeforeCheckIn: 24, refundPercent: 50 },
  ],
};

const owner = await user("testb-owner@bms.test", "Test Owner B", "PARTNER_OWNER", "+919900000101");
const guest = await user("testb-guest@bms.test", "Asha Guest", "CUSTOMER", "+919900000102");

let [partner] = await db.select().from(partners).where(eq(partners.email, "testb-partner@bms.test"));
if (!partner)
  [partner] = await db
    .insert(partners)
    .values({
      legalName: "Test Stays B Pvt Ltd",
      displayName: "Test Stays B",
      contactName: "Test Owner B",
      email: "testb-partner@bms.test",
      phone: "+919900000101",
      bankAccountName: "Test Stays B Pvt Ltd",
      bankAccountNumberEnc: encrypt("50100012345678"),
      bankAccountLast4: "5678",
      bankIfsc: "HDFC0000001",
      kycStatus: "VERIFIED",
      razorpayLinkedAccountId: "acc_mock_testb",
      settlementCycle: "AFTER_CHECKOUT",
      settlementDelayDays: 0,
      defaultCommissionType: "PERCENT",
      defaultCommissionValue: 1500,
      defaultCancellationPolicy: policy,
      defaultTerms: "Valid government photo ID required at check-in.",
    })
    .returning();
await db.insert(partnerUsers).values({ partnerId: partner.id, userId: owner.id, permissions: [] }).onConflictDoNothing();

const [goa] = await db.select().from(cities).where(eq(cities.slug, "goa"));
let [property] = await db.select().from(properties).where(eq(properties.slug, "testb-sea-view-villa"));
if (!property)
  [property] = await db
    .insert(properties)
    .values({
      partnerId: partner.id,
      name: "TestB Sea View Villa",
      slug: "testb-sea-view-villa",
      type: "VILLA",
      cityId: goa?.id,
      address: "12 Beach Road, Candolim, Goa",
      contactPhone: "+919900000103",
      contactEmail: "testb-frontdesk@bms.test",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      cancellationPolicy: policy,
      terms: "No loud music after 10 pm.",
      status: "LIVE",
      startingPrice: 400000,
      publishedAt: new Date(),
    })
    .returning();

async function roomType(name: string, v: Partial<typeof roomTypes.$inferInsert> & { basePrice: number }) {
  const [rt] = await db
    .select()
    .from(roomTypes)
    .where(and(eq(roomTypes.propertyId, property.id), eq(roomTypes.name, name)));
  if (rt) return rt;
  const [created] = await db
    .insert(roomTypes)
    .values({ propertyId: property.id, name, status: "ACTIVE", ...v })
    .returning();
  return created;
}
async function ratePlan(rt: typeof roomTypes.$inferSelect, name: string, v: Partial<typeof ratePlans.$inferInsert> & { basePrice: number }) {
  const [rp] = await db
    .select()
    .from(ratePlans)
    .where(and(eq(ratePlans.roomTypeId, rt.id), eq(ratePlans.name, name)));
  if (rp) return rp;
  const [created] = await db.insert(ratePlans).values({ roomTypeId: rt.id, name, ...v }).returning();
  return created;
}

const deluxe = await roomType("Deluxe Room", { basePrice: 400000, totalRooms: 3, maxAdults: 3, maxChildren: 2, maxOccupancy: 4, sort: 1 });
const suite = await roomType("Pool Suite", { basePrice: 900000, totalRooms: 1, maxAdults: 2, maxChildren: 1, maxOccupancy: 3, sort: 2 });
const deluxeEp = await ratePlan(deluxe, "Room only", { basePrice: 400000, extraAdultPrice: 100000, extraChildPrice: 50000, mealPlan: "EP", sort: 1 });
const deluxeCp = await ratePlan(deluxe, "With breakfast", { basePrice: 450000, extraAdultPrice: 120000, extraChildPrice: 60000, mealPlan: "CP", inclusions: ["Breakfast"], sort: 2 });
const suiteEp = await ratePlan(suite, "Room only (non-refundable)", { basePrice: 900000, mealPlan: "EP", isRefundable: false, sort: 1 });

const [rule] = await db.select().from(commissionRules).where(eq(commissionRules.roomTypeId, suite.id));
if (!rule)
  await db.insert(commissionRules).values({
    partnerId: partner.id,
    propertyId: property.id,
    roomTypeId: suite.id,
    type: "PERCENT",
    value: 1000,
    effectiveFrom: "2020-01-01",
    notes: "Suite at 10%",
  });

await db
  .insert(coupons)
  .values({ code: "TESTB10", type: "PERCENT", value: 1000, maxDiscount: 50000, fundedBy: "PLATFORM", perUserLimit: 5 })
  .onConflictDoNothing({ target: coupons.code });

console.log(
  JSON.stringify(
    {
      password: PASSWORD,
      ownerEmail: owner.email,
      guestEmail: guest.email,
      partnerId: partner.id,
      propertyId: property.id,
      propertySlug: property.slug,
      deluxeId: deluxe.id,
      suiteId: suite.id,
      deluxeEpId: deluxeEp.id,
      deluxeCpId: deluxeCp.id,
      suiteEpId: suiteEp.id,
    },
    null,
    2,
  ),
);
process.exit(0);
