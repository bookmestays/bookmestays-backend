// Base data: first super admin, amenity catalogue, launch cities, default homepage sections.
// Safe to re-run (upserts / skips existing rows).  Run: bun run seed
import { sql } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db";
import { amenities, cities, homeSections, siteSettings, testimonials, users } from "../db/schema";
import { eq } from "drizzle-orm";
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
  if (count > 0) {
    // Migrate existing installs: the old "Why BookMeStays" slot now hosts testimonials,
    // and add the Gold / Rising rows if they are missing. (Never deletes existing rows.)
    await db
      .update(homeSections)
      .set({ type: "TESTIMONIALS", title: "Loved by our guests", subtitle: "Real stays, real stories" })
      .where(eq(homeSections.type, "WHY_BOOKMESTAYS"));
    const all = await db.select().from(homeSections);
    let nextSort = Math.max(0, ...all.map((s) => s.sort)) + 1;
    for (const [type, title, subtitle] of [
      ["GOLD", "Gold Collection", "Our most-booked, guest-loved stays"] as const,
      ["RISING", "Rising Stays", "Fast-rising favourites gaining momentum"] as const,
    ]) {
      if (all.some((s) => s.type === type)) continue;
      await db.insert(homeSections).values({ type, title, subtitle, config: { limit: 12 }, sort: nextSort++ });
    }
    return console.log("• home sections migrated (testimonials + tiers)");
  }
  await db.insert(homeSections).values([
    { type: "RECOMMENDED", title: "Recommended Stays", subtitle: "Handpicked for you", config: { limit: 10 }, sort: 1 },
    { type: "PROPERTY_TYPES", title: "Explore by Property Type", config: {}, sort: 2 },
    { type: "GOLD", title: "Gold Collection", subtitle: "Our most-booked, guest-loved stays", config: { limit: 12 }, sort: 3 },
    { type: "RISING", title: "Rising Stays", subtitle: "Fast-rising favourites gaining momentum", config: { limit: 12 }, sort: 4 },
    { type: "FEATURED", title: "Featured & Popular Stays", config: { limit: 10 }, sort: 5 },
    { type: "VIDEO_DISCOVERY", title: "See it before you book it", subtitle: "Short walkthroughs of real stays", config: { limit: 12 }, sort: 6 },
    { type: "EXPERIENCES", title: "Experiences", subtitle: "Make more of your stay", config: { limit: 8 }, sort: 7 },
    { type: "CITIES", title: "Explore by City", config: {}, sort: 8 },
    { type: "COLLECTIONS", title: "Curated Collections", config: { limit: 6 }, sort: 9 },
    { type: "CITY_SPOTLIGHT", title: "The Best Kind of Stay in Jaipur", config: { citySlug: "jaipur" }, sort: 10 },
    { type: "TESTIMONIALS", title: "Loved by our guests", subtitle: "Real stays, real stories", config: {}, sort: 11 },
  ]);
  console.log("• home sections: 11");
}

const SAMPLE_TESTIMONIALS = [
  {
    authorName: "Ananya Sharma",
    authorTitle: "Family holiday",
    authorLocation: "Mumbai",
    quote:
      "The video walkthrough was exactly what we got — no surprises at check-in. Booking for my parents and kids was effortless, and the stay was spotless. BookMeStays is the only site I trust now.",
    rating: 5,
    isFeatured: true,
    sort: 0,
  },
  {
    authorName: "Rahul Verma",
    authorTitle: "Weekend getaway",
    authorLocation: "Delhi",
    quote: "Found a private pool villa near Lonavala in minutes. Transparent pricing with taxes shown upfront — paid exactly what I saw. Brilliant experience end to end.",
    rating: 5,
    sort: 1,
  },
  {
    authorName: "Meera Nair",
    authorTitle: "Honeymoon",
    authorLocation: "Kochi",
    quote: "We wanted something special and the curated collections made it so easy. The heritage stay we picked was even better than the photos. Highly recommend!",
    rating: 5,
    sort: 2,
  },
  {
    authorName: "Arjun Mehta",
    authorTitle: "Business trip",
    authorLocation: "Bengaluru",
    quote: "Clear room info, real reviews and a booking flow that just works. Changed my dates once and it was painless. This is how booking a stay should feel.",
    rating: 4,
    sort: 3,
  },
];

async function seedTestimonials() {
  const count = await db.$count(testimonials);
  if (count > 0) return console.log("• testimonials exist");
  await db.insert(testimonials).values(SAMPLE_TESTIMONIALS);
  console.log(`• testimonials: ${SAMPLE_TESTIMONIALS.length}`);
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
        key: "tiers",
        value: {
          gold: { enabled: true, windowDays: 7, minBookings: 12 },
          rising: { enabled: true, windowDays: 7, minBookings: 15 },
        },
      },
      {
        key: "support",
        value: { phone: "+91 00000 00000", email: "bookmestaysupport@gmail.com", whatsapp: "", social: {} },
      },
      {
        key: "notice",
        value: { enabled: false, text: "", speed: "normal" },
      },
    ])
    .onConflictDoNothing({ target: siteSettings.key });
  console.log("• settings");
}

await seedAdmin();
await seedAmenities();
await seedCities();
await seedHomeSections();
await seedTestimonials();
await seedSettings();
console.log("✅ seed complete");
process.exit(0);
