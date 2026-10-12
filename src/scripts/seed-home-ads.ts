// Seeds placeholder ad posters (frontend public/ads/*.svg) after the main home
// sections. Only runs when no posters exist, so admin uploads are never touched.
//   bun run src/scripts/seed-home-ads.ts
import { count } from "drizzle-orm";
import { db } from "../db";
import { homeAds } from "../db/schema";

const POSTERS = [
  { slug: "villas", title: "Private pool villas", afterSection: "RECOMMENDED", linkUrl: "/search?type=VILLA" },
  { slug: "heritage", title: "Heritage collection", afterSection: "PROPERTY_TYPES", linkUrl: "/search?type=HERITAGE" },
  { slug: "workcation", title: "Workcations", afterSection: "FEATURED", linkUrl: "/search?tags=CORPORATE" },
] as const;

const [{ n }] = await db.select({ n: count() }).from(homeAds);
if (n > 0) {
  console.log(`home_ads already has ${n} row(s) — nothing to do`);
} else {
  await db.insert(homeAds).values(
    POSTERS.map((p, i) => ({
      title: p.title,
      afterSection: p.afterSection,
      imageUrl: `/ads/${p.slug}-desktop.svg`,
      imageWidth: 2400,
      imageHeight: 300,
      mobileImageUrl: `/ads/${p.slug}-mobile.svg`,
      mobileImageWidth: 1200,
      mobileImageHeight: 400,
      linkUrl: p.linkUrl,
      sort: i,
    })),
  );
  console.log(`Seeded ${POSTERS.length} ad posters`);
}
process.exit(0);
