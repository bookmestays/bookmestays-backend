// Base data: first super admin, amenity catalogue, launch cities, default homepage sections.
// Safe to re-run (upserts / skips existing rows).  Run: bun run seed
import { sql } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db";
import { amenities, cities, homeSections, siteSettings, users } from "../db/schema";
import { slugify } from "../lib/utils";

async function seedAdmin() {
  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${env.seedAdminEmail.toLowerCase()}`,
  });
  if (existing) return console.log(`• admin exists: ${env.seedAdminEmail}`);
  await db.insert(users).values({
    name: "Super Admin",
    email: env.seedAdminEmail.toLowerCase(),
    passwordHash: await Bun.password.hash(env.seedAdminPassword),
    role: "SUPER_ADMIN",
    emailVerified: true,
  });
  console.log(`• admin created: ${env.seedAdminEmail} / ${env.seedAdminPassword}`);
}

const AMENITIES: [code: string, name: string, icon: string, category: string, scope: "PROPERTY" | "ROOM" | "BOTH"][] = [
  ["wifi", "Free Wi-Fi", "wifi", "Essentials", "BOTH"],
  ["ac", "Air conditioning", "snowflake", "Essentials", "ROOM"],
  ["tv", "TV", "tv", "Room", "ROOM"],
  ["hot_water", "Hot water", "droplet", "Essentials", "ROOM"],
  ["minibar", "Minibar", "wine", "Room", "ROOM"],
  ["kettle", "Tea/coffee maker", "coffee", "Room", "ROOM"],
  ["safe", "In-room safe", "lock", "Room", "ROOM"],
  ["balcony", "Balcony", "door-open", "Room", "ROOM"],
  ["bathtub", "Bathtub", "bath", "Room", "ROOM"],
  ["workdesk", "Work desk", "briefcase", "Room", "ROOM"],
  ["parking", "Free parking", "car", "Property", "PROPERTY"],
  ["pool", "Swimming pool", "waves", "Property", "PROPERTY"],
  ["private_pool", "Private pool", "waves", "Property", "BOTH"],
  ["restaurant", "Restaurant", "utensils", "Food & Dining", "PROPERTY"],
  ["room_service", "24h room service", "bell", "Food & Dining", "PROPERTY"],
  ["bar", "Bar", "martini", "Food & Dining", "PROPERTY"],
  ["kitchen", "Kitchen", "chef-hat", "Food & Dining", "BOTH"],
  ["gym", "Fitness centre", "dumbbell", "Wellness", "PROPERTY"],
  ["spa", "Spa", "flower", "Wellness", "PROPERTY"],
  ["garden", "Garden", "trees", "Property", "PROPERTY"],
  ["bonfire", "Bonfire area", "flame", "Experiences", "PROPERTY"],
  ["lift", "Elevator", "arrow-up-down", "Accessibility", "PROPERTY"],
  ["wheelchair", "Wheelchair accessible", "accessibility", "Accessibility", "PROPERTY"],
  ["power_backup", "Power backup", "zap", "Essentials", "PROPERTY"],
  ["front_desk", "24h front desk", "concierge-bell", "Services", "PROPERTY"],
  ["airport_transfer", "Airport transfer", "plane", "Services", "PROPERTY"],
  ["laundry", "Laundry service", "shirt", "Services", "PROPERTY"],
  ["caretaker", "Caretaker on site", "user-check", "Services", "PROPERTY"],
  ["pet_friendly", "Pet friendly", "paw-print", "Policies", "PROPERTY"],
  ["couple_friendly", "Couple friendly", "heart", "Policies", "PROPERTY"],
  ["meeting_room", "Meeting room", "presentation", "Business", "PROPERTY"],
  ["kids_play", "Kids play area", "baby", "Family", "PROPERTY"],
];

async function seedAmenities() {
  await db
    .insert(amenities)
    .values(AMENITIES.map(([code, name, icon, category, scope], i) => ({ code, name, icon, category, scope, sort: i })))
    .onConflictDoNothing({ target: amenities.code });
  console.log(`• amenities: ${AMENITIES.length}`);
}

const CITIES: [name: string, state: string, lat: number, lng: number, intro: string][] = [
  ["Jaipur", "Rajasthan", 26.9124, 75.7873, "The Pink City — palaces, forts, bazaars and some of India's finest heritage stays."],
  ["Udaipur", "Rajasthan", 24.5854, 73.7125, "The City of Lakes, with lakeside palaces and romantic boutique stays."],
  ["Goa", "Goa", 15.2993, 74.124, "Beaches, villas with private pools and relaxed Portuguese-era homestays."],
  ["Mumbai", "Maharashtra", 19.076, 72.8777, "India's busiest city — business hotels, sea-facing stays and weekend escapes nearby."],
  ["Lonavala", "Maharashtra", 18.7546, 73.4062, "Hill-station villas and farmhouses a short drive from Mumbai and Pune."],
  ["Manali", "Himachal Pradesh", 32.2432, 77.1892, "Mountain homestays, cottages and snow views."],
  ["Rishikesh", "Uttarakhand", 30.0869, 78.2676, "Riverside stays, yoga retreats and adventure."],
  ["Delhi", "Delhi", 28.6139, 77.209, "The capital — heritage havelis, business hotels and great food."],
];

async function seedCities() {
  await db
    .insert(cities)
    .values(
      CITIES.map(([name, state, lat, lng, intro], i) => ({
        name,
        slug: slugify(name),
        state,
        lat,
        lng,
        intro,
        isFeatured: i < 6,
        sort: i,
      })),
    )
    .onConflictDoNothing({ target: cities.slug });
  console.log(`• cities: ${CITIES.length}`);
}

async function seedHomeSections() {
  const count = await db.$count(homeSections);
  if (count > 0) return console.log("• home sections exist");
  await db.insert(homeSections).values([
    { type: "RECOMMENDED", title: "Recommended Stays", subtitle: "Handpicked for you", config: { limit: 10 }, sort: 1 },
    { type: "PROPERTY_TYPES", title: "Explore by Property Type", config: {}, sort: 2 },
    { type: "FEATURED", title: "Featured & Popular Stays", config: { limit: 10 }, sort: 3 },
    { type: "VIDEO_DISCOVERY", title: "See it before you book it", subtitle: "Short walkthroughs of real stays", config: { limit: 12 }, sort: 4 },
    { type: "EXPERIENCES", title: "Experiences", subtitle: "Make more of your stay", config: { limit: 8 }, sort: 5 },
    { type: "CITIES", title: "Explore by City", config: {}, sort: 6 },
    { type: "COLLECTIONS", title: "Curated Collections", config: { limit: 6 }, sort: 7 },
    { type: "CITY_SPOTLIGHT", title: "The Best Kind of Stay in Jaipur", config: { citySlug: "jaipur" }, sort: 8 },
    { type: "WHY_BOOKMESTAYS", title: "Why BookMeStays", config: {}, sort: 9 },
  ]);
  console.log("• home sections: 9");
}

async function seedSettings() {
  // Tax configuration — confirm rates with your CA; editable later from admin settings.
  await db
    .insert(siteSettings)
    .values([
      {
        key: "tax",
        value: {
          // GST on accommodation by per-night tariff (slabs in paise; rate in bps)
          roomGstSlabs: [
            { upToPerNight: 750000, rateBps: 500 },
            { upToPerNight: null, rateBps: 1800 },
          ],
          commissionGstBps: 1800, // GST on our commission
          tcsBps: 50, // GST TCS u/s 52 on net taxable supplies
          tdsBps: 10, // Income-tax TDS u/s 194-O on gross amount
        },
      },
      { key: "booking", value: { holdMinutes: 15, maxRoomsPerBooking: 5, maxNights: 30 } },
      {
        key: "support",
        value: { phone: "+91 00000 00000", email: "bookmestaysupport@gmail.com", whatsapp: "", social: {} },
      },
    ])
    .onConflictDoNothing({ target: siteSettings.key });
  console.log("• settings");
}

await seedAdmin();
await seedAmenities();
await seedCities();
await seedHomeSections();
await seedSettings();
console.log("✅ seed complete");
process.exit(0);
