// Demo data for development / QA: a demo partner with ~11 LIVE properties across the seeded cities
// (all 5 property types, all travel tags), room types + rate plans, amenities, nearby places,
// images + preview videos, experiences, collections, hero banners and published reviews.
//
//   bun run seed            # base data first (admin, amenities, cities, home sections)
//   bun run seed:demo       # skips when the demo partner already exists
//   bun run seed:demo --reset   # removes previous demo data and recreates it
//
// Logins: partner@demo.bookmestays.com / Partner@123  ·  guest@demo.bookmestays.com / Guest@123
//
// Media: images are Unsplash photos (https://images.unsplash.com/photo-<id>?w=1600&q=80) and videos are
// Mixkit free stock clips — every URL was verified to return HTTP 200 before being added here.
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  amenities,
  areas,
  banners,
  cities,
  collectionItems,
  collections,
  experiences,
  media,
  nearbyPlaces,
  partners,
  partnerUsers,
  properties,
  propertyAmenities,
  ratePlans,
  reviews,
  roomTypeAmenities,
  roomTypes,
  users,
  type CancellationPolicy,
} from "../db/schema";
import { encrypt, slugify } from "../lib/utils";

// Unsplash photo ids by category (all verified 200).
const IMG = {
  hotel_exterior: [
    "1566073771259-6a8506099945",
    "1551016043-06ec2173531b",
    "1607320895054-c5c543e9a069",
    "1561501900-3701fa6a0864",
    "1540541338287-41700207dee6",
    "1571896349842-33c89424de2d",
    "1520250497591-112f2f40a3f4",
    "1607320879139-1bb689f6a68f",
    "1607320874448-d33f052651e2",
    "1542314831-068cd1dbfeeb",
    "1564501049412-61c2a3083791",
    "1587870306141-4f19861e6c73",
  ],
  villa_exterior: [
    "1580587771525-78b9dba3b914",
    "1613977257365-aaae5a9817ff",
    "1600596542815-ffad4c1539a9",
    "1512917774080-9991f1c4c750",
    "1613977257592-4871e5fcd7c4",
    "1602343168117-bb8ffe3e2e9f",
    "1582268611958-ebfd161ef9cf",
    "1613490493576-7fde63acd811",
    "1593714604578-d9e41b00c6c6",
  ],
  pool: [
    "1623718649591-311775a30c43",
    "1610641818989-c2051b5e2cfd",
    "1549294413-26f195200c16",
    "1584132869994-873f9363a562",
    "1596436889106-be35e843f974",
    "1563911302283-d2bc129e7570",
    "1623812058330-ccfa078cffb3",
    "1582719508461-905c673771fd",
  ],
  room: [
    "1618773928121-c32242e63f39",
    "1611892440504-42a792e24d32",
    "1629140727571-9b5c6f6267b4",
    "1631049307264-da0ec9d70304",
    "1631049552057-403cdb8f0658",
    "1568495248636-6432b97bd949",
    "1590490360182-c33d57733427",
    "1576354302919-96748cb8299e",
    "1582719478250-c89cae4dc85b",
    "1549638441-b787d2e11f14",
    "1590381105924-c72589b9ef3f",
    "1560185893-a55cbc8c57e8",
    "1616486029423-aaa4789e8c9a",
    "1552858725-2758b5fb1286",
    "1616594092403-fb65629b0a46",
    "1600210491305-7396500b5b31",
    "1630660664869-c9d3cc676880",
  ],
  bathroom: [
    "1664917555352-f3f66e57ccc2",
    "1646974400439-8472d58bb19e",
    "1596194789619-e0ff3e3f310a",
    "1611971263575-ab653c31a5a9",
    "1673789692010-c424b6529e2d",
    "1718894070114-6de0e98449a2",
    "1673557818087-4056db868568",
    "1552321554-5fefe8c9ef14",
    "1584622650111-993a426fbf0a",
  ],
  view: [
    "1454496522488-7a8e488e8606",
    "1584395631446-e41b0fc3f68d",
    "1513614835783-51537729c8ba",
    "1718799340126-59ca9e145907",
    "1614082242765-7c98ca0f3df3",
    "1642516864335-2ca9d8b3a511",
    "1757702244726-00198554c4a0",
    "1622725859789-8e9ccf920693",
    "1506832424678-e8232f4a068d",
  ],
  dining: [
    "1551632436-cbf8dd35adfa",
    "1613946069412-38f7f1ff0b65",
    "1636405188904-bc706f07aa37",
    "1633327760690-d9bb0513f942",
    "1611601184963-9d1de9b79ff3",
    "1625398407796-82650a8c135f",
    "1585937421612-70a008356fbe",
    "1584278858944-7c34f1d94db0",
  ],
  common_area: [
    "1621293954908-907159247fc8",
    "1646991761123-d83ce47c30c9",
    "1723516908282-b3c795e9416a",
    "1759038085950-1234ca8f5fed",
    "1628630468464-4168a51129f1",
    "1615529182904-14819c35db37",
    "1632641252948-ccbc2fb7d6e9",
    "1584132967334-10e028bd69f7",
  ],
  heritage: [
    "1477587458883-47145ed94245",
    "1578999935853-4ec5fa6c1f60",
    "1661924326425-c14a6426d989",
    "1599661046289-e31897846e41",
    "1589901164570-f9de6556e1c1",
    "1695956353120-54ce5e91632b",
    "1682414181248-8b0d51289e88",
    "1682414181885-a22c7a922cd7",
    "1667099639128-4b10f464f4a2",
  ],
  farmhouse_nature: [
    "1571524188026-cc1d649962ea",
    "1515524042669-de726ea3283d",
    "1580202313707-46a966af5c6f",
    "1573652102907-b75d25910c11",
    "1604601638406-edc29b54dcf7",
    "1654445112674-85c94a3eae7b",
    "1742071853836-997f0a47faf3",
  ],
  homestay: [
    "1570793005386-840846445fed",
    "1583878594798-c31409c8ab4a",
    "1609349093648-51d2ceb5a72a",
    "1571677465484-2dd540924245",
    "1588880331179-bc9b93a8cb5e",
    "1475087542963-13ab5e611954",
  ],
  jaipur: [
    "1477587458883-47145ed94245",
    "1599661046289-e31897846e41",
  ],
  udaipur: [
    "1589901164570-f9de6556e1c1",
    "1615836245337-f5b9b2303f10",
  ],
  goa: [
    "1614082242765-7c98ca0f3df3",
    "1512343879784-a960bf40e7f2",
  ],
  mumbai: [
    "1595658658481-d53d3f999875",
    "1570168007204-dfb528c6958f",
  ],
  lonavala: [
    "1622725859789-8e9ccf920693",
    "1706408660346-18d868dced23",
  ],
  manali: [
    "1597167231350-d057a45dc868",
    "1606667544139-81e47935d769",
  ],
  rishikesh: [
    "1712510817140-917938f92e5b",
    "1720819029162-8500607ae232",
  ],
  delhi: [
    "1587474260584-136574528ed5",
    "1632426237957-5ea14aae7100",
  ],
  experience: [
    "1507608869274-d3177c8bb4c7",
    "1615836245337-f5b9b2303f10",
    "1609828913552-f9138ed9e42d",
    "1601050690597-df0568f70950",
    "1562088287-bde35a1ea917",
    "1512675628397-28288d1220ef",
    "1642933196504-62107dac9258",
    "1551632811-561732d1e306",
    "1688013753619-deb0a2fd6fc5",
    "1636391538092-00a389187fe7",
    "1547234936-74a4b1ee7f42",
  ],
  attraction: [
    "1564507592333-c60657eea523",
    "1566915682737-3e97a7eed93b",
    "1557062975-96113e46608b",
    "1616377009507-c8111f07aced",
    "1593359652766-b77c5795bd65",
    "1667849521403-d8723972f0a0",
    "1575566668200-7dcaa7b2cf28",
    "1529253355930-ddbe423a2ac7",
    "1607406374368-809f8ec7f118",
  ],
} as const;

// Videos: Mixkit free stock clips (720p MP4), every URL verified with `curl -sIL` → 200 video/mp4.
const VIDEO = {
  roomPan: "https://assets.mixkit.co/videos/4196/4196-720.mp4",
  roomInterior: "https://assets.mixkit.co/videos/4198/4198-720.mp4",
  boutiqueRoom: "https://assets.mixkit.co/videos/4046/4046-720.mp4",
  roomTerrace: "https://assets.mixkit.co/videos/4029/4029-720.mp4",
  breakfast: "https://assets.mixkit.co/videos/15642/15642-720.mp4",
  roomBreakfast: "https://assets.mixkit.co/videos/4019/4019-720.mp4",
  resortPoolSea: "https://assets.mixkit.co/videos/9902/9902-720.mp4",
  resortWaterslides: "https://assets.mixkit.co/videos/49555/49555-720.mp4",
  poolTimelapse: "https://assets.mixkit.co/videos/4044/4044-720.mp4",
  rooftopPool: "https://assets.mixkit.co/videos/3105/3105-720.mp4",
  infinityPool: "https://assets.mixkit.co/videos/2676/2676-720.mp4",
  beach: "https://assets.mixkit.co/videos/3108/3108-720.mp4",
  beachAerial: "https://assets.mixkit.co/videos/5371/5371-720.mp4",
  sunsetTerrace: "https://assets.mixkit.co/videos/44500/44500-720.mp4",
  sunsetBeach: "https://assets.mixkit.co/videos/2168/2168-720.mp4",
  beachShore: "https://assets.mixkit.co/videos/1085/1085-720.mp4",
  mountains: "https://assets.mixkit.co/videos/4132/4132-720.mp4",
  snowyMountains: "https://assets.mixkit.co/videos/4396/4396-720.mp4",
  lakeSunset: "https://assets.mixkit.co/videos/4998/4998-720.mp4",
  greenHills: "https://assets.mixkit.co/videos/5360/5360-720.mp4",
  hotelCorridor: "https://assets.mixkit.co/videos/34613/34613-720.mp4",
} as const;

type ImgCat = keyof typeof IMG;
const img = (cat: ImgCat, i: number) => {
  const list = IMG[cat];
  return `https://images.unsplash.com/photo-${list[i % list.length]}?w=1600&q=80`;
};

const DEMO_PARTNER_EMAIL = "partner@demo.bookmestays.com";
const DEMO_PARTNER_PASSWORD = "Partner@123";
const DEMO_GUEST_EMAIL = "guest@demo.bookmestays.com";
const DEMO_GUEST_PASSWORD = "Guest@123";
const REVIEWERS = [
  ["Ananya Sharma", "ananya@demo.bookmestays.com"],
  ["Rohan Mehta", "rohan@demo.bookmestays.com"],
  ["Priya Nair", "priya@demo.bookmestays.com"],
  ["Karan Malhotra", "karan@demo.bookmestays.com"],
] as const;
const DEMO_USER_EMAILS = [DEMO_PARTNER_EMAIL, DEMO_GUEST_EMAIL, ...REVIEWERS.map(([, e]) => e)];

const rupees = (r: number) => r * 100;

const FLEXIBLE: CancellationPolicy = {
  summary: "Free cancellation up to 48 hours before check-in. 50% refund within 48 hours.",
  rules: [
    { hoursBeforeCheckIn: 48, refundPercent: 100 },
    { hoursBeforeCheckIn: 0, refundPercent: 50 },
  ],
};
const MODERATE: CancellationPolicy = {
  summary: "Full refund up to 7 days before check-in, 50% up to 72 hours, non-refundable after that.",
  rules: [
    { hoursBeforeCheckIn: 168, refundPercent: 100 },
    { hoursBeforeCheckIn: 72, refundPercent: 50 },
    { hoursBeforeCheckIn: 0, refundPercent: 0 },
  ],
};
const NON_REFUNDABLE: CancellationPolicy = { summary: "Non-refundable rate.", rules: [{ hoursBeforeCheckIn: 0, refundPercent: 0 }] };

const AREAS: Record<string, [name: string, description: string, recommended: boolean][]> = {
  jaipur: [
    ["Old City", "The walled Pink City around Hawa Mahal and the bazaars.", true],
    ["C-Scheme", "Central, leafy business district with cafes and malls.", false],
    ["Amer", "Around Amber Fort, quieter and scenic.", true],
  ],
  udaipur: [
    ["Lake Pichola", "Lakefront ghats with palace views.", true],
    ["Fateh Sagar", "Breezy lakeside promenade, great for sunsets.", false],
  ],
  goa: [
    ["Assagao", "Leafy North Goa village with villas and cafes.", true],
    ["Benaulim", "Quiet South Goa beach village.", true],
    ["Candolim", "Lively North Goa beach strip.", false],
  ],
  mumbai: [
    ["Marine Drive", "Sea-facing art deco promenade in South Mumbai.", true],
    ["Bandra Kurla Complex", "Business district close to the airport.", false],
  ],
  lonavala: [
    ["Tungarli", "Hilltop villas above the lake.", true],
    ["Pawna Lake", "Farm stays and camping by the lake.", true],
  ],
  manali: [
    ["Old Manali", "Cafes, orchards and cottages above the Manalsu river.", true],
    ["Vashisht", "Hot springs and temple village across the Beas.", false],
  ],
  rishikesh: [
    ["Tapovan", "Yoga schools and cafes near Laxman Jhula.", true],
    ["Shivpuri", "Rafting and riverside camps upstream.", false],
  ],
  delhi: [
    ["Old Delhi", "Chandni Chowk, havelis and street food.", true],
    ["Aerocity", "Hotels next to the international airport.", false],
  ],
};

const CITY_CONTENT: Record<string, { cover: string; travelInfo: string; foodGuide: string }> = {
  jaipur: {
    cover: img("jaipur", 0),
    travelInfo: "Best from October to March. Jaipur International Airport (JAI) is 13 km from the Old City; Jaipur Junction connects to Delhi in under 5 hours by Vande Bharat.",
    foodGuide: "Try dal baati churma, pyaaz kachori at Rawat, lassi at Lassiwala on MI Road and a royal Rajasthani thali.",
  },
  udaipur: {
    cover: img("udaipur", 0),
    travelInfo: "Pleasant from September to March; monsoon fills the lakes. Maharana Pratap Airport (UDR) is 22 km from the city.",
    foodGuide: "Lakeside rooftop dining, dal pakwan for breakfast and gatte ki sabzi.",
  },
  goa: {
    cover: img("goa", 0),
    travelInfo: "Peak season November–February. Two airports: Dabolim (GOI) and Mopa (GOX) in the north.",
    foodGuide: "Fish curry rice, prawn balchão, bebinca and feni — beach shacks and Portuguese-era taverns.",
  },
  mumbai: {
    cover: img("mumbai", 0),
    travelInfo: "Year-round business hub; monsoon from June to September. Chhatrapati Shivaji Maharaj International Airport (BOM).",
    foodGuide: "Vada pav, pav bhaji at Juhu, Irani cafes in Fort and seafood at Mahesh Lunch Home.",
  },
  lonavala: {
    cover: img("lonavala", 0),
    travelInfo: "Monsoon (June–September) turns the Sahyadris green. 90 minutes from Mumbai and 1 hour from Pune by expressway.",
    foodGuide: "Chikki, fudge, corn bhutta in the rain and Maharashtrian thalis on the old highway.",
  },
  manali: {
    cover: img("manali", 0),
    travelInfo: "Snow from December to February; summer escape April–June. Nearest airport Bhuntar (KUU), 50 km.",
    foodGuide: "Trout, siddu, Himachali dham and apple pie in Old Manali cafes.",
  },
  rishikesh: {
    cover: img("rishikesh", 0),
    travelInfo: "Rafting season September–June. Jolly Grant Airport (DED) is 35 km away.",
    foodGuide: "Vegetarian town — cafes along Laxman Jhula, aloo puri breakfasts and ginger-lemon-honey tea.",
  },
  delhi: {
    cover: img("delhi", 0),
    travelInfo: "Best October–March. Indira Gandhi International Airport (DEL) with Airport Express metro.",
    foodGuide: "Parathe wali gali, butter chicken, chaat in Chandni Chowk and kebabs at Jama Masjid.",
  },
};

type MediaSpec = { kind: "IMAGE" | "VIDEO"; url: string; tag: MediaTag; title?: string; posterUrl?: string; durationSec?: number };
type MediaTag = "EXTERIOR" | "ROOM_WALKTHROUGH" | "ROOM" | "BATHROOM" | "VIEW" | "COMMON_AREA" | "POOL" | "DINING" | "SURROUNDINGS" | "EXPERIENCE" | "AMENITY" | "OTHER";
type PlanSpec = { name: string; mealPlan: "EP" | "CP" | "MAP" | "AP"; price: number; inclusions: string[]; refundable?: boolean };
type RoomSpec = {
  name: string;
  description: string;
  maxAdults: number;
  maxChildren: number;
  bed: string;
  sqft: number;
  view: string;
  total: number;
  amenities: string[];
  images: string[];
  plans: PlanSpec[];
};
type PropertySpec = {
  name: string;
  city: string;
  area: string;
  type: "HOTEL" | "VILLA" | "FARMHOUSE" | "HOMESTAY" | "HERITAGE";
  tags: ("CORPORATE" | "FAMILY" | "COUPLES" | "FRIENDS")[];
  star: number | null;
  short: string;
  description: string;
  highlights: string[];
  food: string;
  address: string;
  pincode: string;
  lat: number;
  lng: number;
  policy: CancellationPolicy;
  rules: string[];
  amenities: string[];
  featured?: boolean;
  recommended?: boolean;
  rank?: number;
  media: MediaSpec[];
  rooms: RoomSpec[];
  nearby: [name: string, category: string, km: number, description: string, image?: string][];
};

const I = (cat: ImgCat, i: number, tag: MediaTag, title?: string): MediaSpec => ({ kind: "IMAGE", url: img(cat, i), tag, title });
const V = (url: string, tag: MediaTag, poster: string, title: string, durationSec = 20): MediaSpec => ({
  kind: "VIDEO",
  url,
  tag,
  posterUrl: poster,
  title,
  durationSec,
});

const BREAKFAST = ["Breakfast for 2", "Welcome drink"];
const HOUSE_RULES = [
  "Check-in from 2 PM, check-out by 11 AM",
  "Government photo ID required for all guests",
  "No smoking inside rooms",
  "Quiet hours 10 PM – 7 AM",
];

const PROPERTIES: PropertySpec[] = [
  {
    name: "The Pink Pearl Haveli",
    city: "jaipur",
    area: "Old City",
    type: "HERITAGE",
    tags: ["COUPLES", "FAMILY"],
    star: 4,
    short: "A restored 19th-century haveli with frescoed courtyards, steps from Hawa Mahal.",
    description:
      "Built in 1872 for a family of jewellers, The Pink Pearl Haveli has been lovingly restored with hand-painted frescoes, jharokha balconies and a rooftop that looks across the Pink City to Nahargarh Fort. Rooms open onto a central courtyard where evening folk music is performed.",
    highlights: ["Rooftop view of Nahargarh Fort", "Evening Rajasthani folk music", "5 min walk to Hawa Mahal", "Heritage walk included"],
    food: "Rooftop restaurant serving Rajasthani thalis and continental breakfast; in-room dining until 11 PM.",
    address: "Near Hawa Mahal, Tripolia Bazaar, Old City, Jaipur, Rajasthan",
    pincode: "302002",
    lat: 26.9239,
    lng: 75.8267,
    policy: FLEXIBLE,
    rules: [...HOUSE_RULES, "Heritage property — some rooms are accessed by stairs"],
    amenities: ["wifi", "restaurant", "room_service", "front_desk", "couple_friendly", "power_backup", "laundry"],
    featured: true,
    recommended: true,
    rank: 10,
    media: [
      I("heritage", 0, "EXTERIOR", "Haveli facade"),
      I("heritage", 3, "COMMON_AREA", "Frescoed courtyard"),
      I("room", 0, "ROOM", "Maharaja suite"),
      I("bathroom", 0, "BATHROOM"),
      I("dining", 1, "DINING", "Rooftop thali"),
      I("heritage", 5, "VIEW", "Rooftop view"),
      V(VIDEO.roomPan, "ROOM_WALKTHROUGH", img("room", 0), "Suite walkthrough", 18),
      V(VIDEO.hotelCorridor, "COMMON_AREA", img("heritage", 3), "Haveli corridors", 12),
    ],
    rooms: [
      {
        name: "Heritage Room",
        description: "Frescoed walls, carved wooden furniture and a window over the bazaar.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 Queen bed",
        sqft: 220,
        view: "Courtyard",
        total: 6,
        amenities: ["wifi", "ac", "tv", "hot_water", "kettle"],
        images: [img("room", 1), img("bathroom", 1)],
        plans: [
          { name: "Room only", mealPlan: "EP", price: rupees(4200), inclusions: ["Welcome drink"] },
          { name: "With breakfast", mealPlan: "CP", price: rupees(4800), inclusions: BREAKFAST },
        ],
      },
      {
        name: "Maharaja Suite",
        description: "Our largest suite with a private jharokha balcony and a marble bathtub.",
        maxAdults: 3,
        maxChildren: 1,
        bed: "1 King bed + daybed",
        sqft: 450,
        view: "Nahargarh Fort",
        total: 2,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "bathtub", "balcony", "safe"],
        images: [img("room", 0), img("bathroom", 2)],
        plans: [{ name: "With breakfast", mealPlan: "CP", price: rupees(8900), inclusions: [...BREAKFAST, "Heritage walk"] }],
      },
    ],
    nearby: [
      ["Hawa Mahal", "ATTRACTION", 0.4, "The iconic Palace of Winds.", img("jaipur", 1)],
      ["Johari Bazaar", "SHOPPING", 0.8, "Jewellery and textiles."],
      ["City Palace", "ATTRACTION", 1.1, "Royal residence and museum."],
      ["Jaipur Junction", "TRANSPORT", 5.2, "Main railway station."],
    ],
  },
  {
    name: "Amber Crest Business Hotel",
    city: "jaipur",
    area: "C-Scheme",
    type: "HOTEL",
    tags: ["CORPORATE", "FAMILY"],
    star: 4,
    short: "Modern 4-star hotel in C-Scheme with a pool, gym and meeting rooms.",
    description:
      "A contemporary hotel in the heart of Jaipur's business district, 20 minutes from the airport. Soundproofed rooms, fast Wi-Fi, a rooftop pool and a 24-hour business centre make it a favourite for work trips and families alike.",
    highlights: ["Rooftop pool", "Airport transfers", "Meeting rooms for 40", "24h business centre"],
    food: "All-day dining restaurant, rooftop bar and 24-hour room service.",
    address: "Ashok Marg, C-Scheme, Jaipur, Rajasthan",
    pincode: "302001",
    lat: 26.9095,
    lng: 75.8045,
    policy: MODERATE,
    rules: HOUSE_RULES,
    amenities: ["wifi", "pool", "gym", "restaurant", "bar", "room_service", "lift", "parking", "meeting_room", "airport_transfer", "front_desk"],
    recommended: true,
    rank: 5,
    media: [
      I("hotel_exterior", 0, "EXTERIOR", "Hotel entrance"),
      I("pool", 0, "POOL", "Rooftop pool"),
      I("room", 2, "ROOM", "Executive room"),
      I("common_area", 0, "COMMON_AREA", "Lobby"),
      I("bathroom", 3, "BATHROOM"),
      I("dining", 0, "DINING", "All-day restaurant"),
      V(VIDEO.boutiqueRoom, "ROOM_WALKTHROUGH", img("room", 2), "Executive room walkthrough", 15),
    ],
    rooms: [
      {
        name: "Superior Room",
        description: "Smart and quiet with a work desk and rain shower.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King or 2 Twin beds",
        sqft: 260,
        view: "City",
        total: 20,
        amenities: ["wifi", "ac", "tv", "hot_water", "kettle", "workdesk", "safe"],
        images: [img("room", 3), img("bathroom", 3)],
        plans: [
          { name: "Room only", mealPlan: "EP", price: rupees(3900), inclusions: [] },
          { name: "Breakfast included", mealPlan: "CP", price: rupees(4500), inclusions: BREAKFAST },
        ],
      },
      {
        name: "Executive Room",
        description: "Higher floor with lounge access and evening cocktails.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King bed",
        sqft: 320,
        view: "Pool",
        total: 10,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "workdesk", "safe", "bathtub"],
        images: [img("room", 2), img("common_area", 1)],
        plans: [
          { name: "Breakfast included", mealPlan: "CP", price: rupees(5600), inclusions: [...BREAKFAST, "Lounge access"] },
          { name: "Non-refundable saver", mealPlan: "CP", price: rupees(5000), inclusions: BREAKFAST, refundable: false },
        ],
      },
      {
        name: "Family Suite",
        description: "Two connected rooms for families of four.",
        maxAdults: 4,
        maxChildren: 2,
        bed: "1 King + 2 Twin beds",
        sqft: 540,
        view: "City",
        total: 4,
        amenities: ["wifi", "ac", "tv", "hot_water", "kettle", "safe"],
        images: [img("room", 4), img("bathroom", 4)],
        plans: [{ name: "Breakfast included", mealPlan: "CP", price: rupees(7800), inclusions: ["Breakfast for 4", "Kids welcome kit"] }],
      },
    ],
    nearby: [
      ["Central Park", "ATTRACTION", 1.0, "Jaipur's largest park with a jogging track."],
      ["World Trade Park", "SHOPPING", 3.5, "Mall with international brands."],
      ["Jaipur International Airport", "TRANSPORT", 11, "Domestic and international flights."],
      ["SMS Hospital", "HOSPITAL", 1.8, "Multi-speciality hospital."],
    ],
  },
  {
    name: "Pichola Lake Palace Residency",
    city: "udaipur",
    area: "Lake Pichola",
    type: "HERITAGE",
    tags: ["COUPLES"],
    star: 5,
    short: "A lakefront palace residency with sunset views of City Palace and Jag Mandir.",
    description:
      "Once a royal guest house on the banks of Lake Pichola, the residency has 18 rooms with lake-facing balconies, a candle-lit rooftop restaurant and a private boat jetty. It's Udaipur's most romantic address.",
    highlights: ["Lake-facing balconies", "Private boat jetty", "Candle-lit rooftop dinners", "Sunset views of City Palace"],
    food: "Rooftop restaurant with Mewari and continental menus; private dining on the jetty on request.",
    address: "Lal Ghat, Lake Pichola, Udaipur, Rajasthan",
    pincode: "313001",
    lat: 24.5786,
    lng: 73.6832,
    policy: MODERATE,
    rules: [...HOUSE_RULES, "Children under 12 not recommended on the rooftop after 8 PM"],
    amenities: ["wifi", "restaurant", "room_service", "spa", "couple_friendly", "front_desk", "airport_transfer"],
    featured: true,
    recommended: true,
    rank: 9,
    media: [
      I("heritage", 4, "EXTERIOR", "Palace on the lake"),
      I("udaipur", 1, "VIEW", "Lake Pichola at dusk"),
      I("room", 5, "ROOM", "Lake view room"),
      I("bathroom", 5, "BATHROOM"),
      I("dining", 2, "DINING", "Rooftop dinner"),
      I("common_area", 2, "COMMON_AREA", "Palace lounge"),
      V(VIDEO.lakeSunset, "VIEW", img("udaipur", 1), "Sunset over the lake", 20),
      V(VIDEO.roomTerrace, "ROOM_WALKTHROUGH", img("room", 5), "Room with terrace", 25),
    ],
    rooms: [
      {
        name: "Lake View Room",
        description: "Balcony directly over the water with views of City Palace.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King bed",
        sqft: 300,
        view: "Lake Pichola",
        total: 8,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "balcony", "safe"],
        images: [img("room", 5), img("view", 1)],
        plans: [
          { name: "Breakfast included", mealPlan: "CP", price: rupees(9500), inclusions: BREAKFAST },
          { name: "Romance package", mealPlan: "MAP", price: rupees(12500), inclusions: [...BREAKFAST, "Candle-lit dinner", "Sunset boat ride"] },
        ],
      },
      {
        name: "Royal Suite",
        description: "Two-room suite with a private terrace and jharokha seating.",
        maxAdults: 2,
        maxChildren: 2,
        bed: "1 King bed",
        sqft: 600,
        view: "Lake Pichola",
        total: 2,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "bathtub", "balcony", "safe"],
        images: [img("room", 6), img("bathroom", 6)],
        plans: [{ name: "Breakfast included", mealPlan: "CP", price: rupees(18500), inclusions: [...BREAKFAST, "Airport transfer"] }],
      },
    ],
    nearby: [
      ["City Palace", "ATTRACTION", 0.9, "Rajasthan's largest palace complex.", img("heritage", 4)],
      ["Bagore Ki Haveli", "ATTRACTION", 0.3, "Evening dance show on Gangaur Ghat."],
      ["Jagdish Temple", "ATTRACTION", 0.7, "Indo-Aryan temple from 1651."],
    ],
  },
  {
    name: "Casa Azul Private Pool Villa",
    city: "goa",
    area: "Assagao",
    type: "VILLA",
    tags: ["FRIENDS", "FAMILY"],
    star: null,
    short: "4-bedroom Portuguese-style villa with a private pool, 10 minutes from Anjuna beach.",
    description:
      "Casa Azul is a whitewashed Indo-Portuguese villa set in a quiet Assagao lane shaded by mango trees. Four en-suite bedrooms open onto a private 30-ft pool and a garden with a barbecue deck. A caretaker and cook are on call.",
    highlights: ["Private 30-ft pool", "Cook & caretaker on call", "10 min to Anjuna & Vagator", "Barbecue deck"],
    food: "Fully equipped kitchen; the on-call cook prepares Goan home meals at a small extra charge.",
    address: "Saunto Vaddo, Assagao, Bardez, North Goa",
    pincode: "403507",
    lat: 15.5937,
    lng: 73.7648,
    policy: MODERATE,
    rules: ["No parties or loud music after 10 PM", "Pets allowed on request", "Security deposit of ₹10,000 collected at check-in"],
    amenities: ["wifi", "private_pool", "kitchen", "parking", "caretaker", "garden", "pet_friendly", "power_backup"],
    featured: true,
    rank: 8,
    media: [
      I("villa_exterior", 0, "EXTERIOR", "Villa exterior"),
      I("pool", 1, "POOL", "Private pool"),
      I("room", 7, "ROOM", "Master bedroom"),
      I("villa_exterior", 1, "COMMON_AREA", "Garden deck"),
      I("bathroom", 7, "BATHROOM"),
      I("goa", 1, "SURROUNDINGS", "Nearby beach"),
      V(VIDEO.infinityPool, "POOL", img("pool", 1), "Pool at sunset", 16),
      V(VIDEO.beachAerial, "SURROUNDINGS", img("goa", 1), "Beaches nearby", 20),
    ],
    rooms: [
      {
        name: "Entire Villa (4 BHK)",
        description: "The whole villa for up to 10 guests with private pool.",
        maxAdults: 8,
        maxChildren: 2,
        bed: "4 King beds",
        sqft: 3200,
        view: "Pool & garden",
        total: 1,
        amenities: ["wifi", "ac", "tv", "hot_water", "kitchen", "private_pool", "balcony"],
        images: [img("villa_exterior", 2), img("pool", 2)],
        plans: [
          { name: "Villa only", mealPlan: "EP", price: rupees(24000), inclusions: ["Caretaker", "Daily housekeeping"] },
          { name: "Villa with breakfast", mealPlan: "CP", price: rupees(27500), inclusions: ["Goan breakfast for 8", "Caretaker"] },
        ],
      },
      {
        name: "Garden Bedroom",
        description: "A private en-suite bedroom with shared pool access (villa shared with hosts' other guests).",
        maxAdults: 2,
        maxChildren: 0,
        bed: "1 Queen bed",
        sqft: 280,
        view: "Garden",
        total: 1,
        amenities: ["wifi", "ac", "hot_water"],
        images: [img("room", 8)],
        plans: [{ name: "Room only", mealPlan: "EP", price: rupees(6500), inclusions: [] }],
      },
    ],
    nearby: [
      ["Anjuna Beach", "ATTRACTION", 4.5, "Flea market on Wednesdays.", img("attraction", 2)],
      ["Vagator Beach", "ATTRACTION", 5.8, "Cliffs and Chapora Fort sunsets."],
      ["Assagao Church", "ATTRACTION", 0.9, "St. Cajetan's church."],
      ["Mopa Airport", "TRANSPORT", 28, "North Goa international airport."],
    ],
  },
  {
    name: "Palm Grove Beach Homestay",
    city: "goa",
    area: "Benaulim",
    type: "HOMESTAY",
    tags: ["COUPLES"],
    star: null,
    short: "A family-run Goan home 200 m from a quiet South Goa beach.",
    description:
      "Hosted by the Fernandes family for three generations, Palm Grove is a 1920s Goan house surrounded by coconut palms. Wake up to Mrs. Fernandes' poi and chorizo breakfasts, cycle to Benaulim beach and fall asleep to the sound of the sea.",
    highlights: ["200 m from Benaulim beach", "Home-cooked Goan breakfast", "Free bicycles", "Hosted by a local family"],
    food: "Breakfast by the hosts; beach shacks and seafood restaurants within walking distance.",
    address: "Vasvaddo, Benaulim, Salcete, South Goa",
    pincode: "403716",
    lat: 15.2536,
    lng: 73.9285,
    policy: FLEXIBLE,
    rules: ["Home stay — please respect the hosts' family space", "No loud music", "No outside guests after 9 PM"],
    amenities: ["wifi", "garden", "parking", "couple_friendly", "caretaker"],
    recommended: true,
    rank: 4,
    media: [
      I("homestay", 0, "EXTERIOR", "Goan home"),
      I("homestay", 1, "COMMON_AREA", "Verandah"),
      I("room", 9, "ROOM", "Sea breeze room"),
      I("bathroom", 8, "BATHROOM"),
      I("view", 3, "SURROUNDINGS", "Benaulim beach"),
      I("dining", 3, "DINING", "Goan breakfast"),
      V(VIDEO.sunsetBeach, "VIEW", img("view", 3), "Sunset at Benaulim", 15),
    ],
    rooms: [
      {
        name: "Sea Breeze Room",
        description: "Airy room with four-poster bed and verandah access.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 Four-poster Queen bed",
        sqft: 240,
        view: "Garden",
        total: 3,
        amenities: ["wifi", "ac", "hot_water", "balcony"],
        images: [img("room", 9), img("homestay", 1)],
        plans: [
          { name: "Room with Goan breakfast", mealPlan: "CP", price: rupees(3200), inclusions: ["Goan breakfast for 2", "Bicycles"] },
        ],
      },
      {
        name: "Attic Loft",
        description: "Cosy wood-panelled loft under the Mangalore-tiled roof.",
        maxAdults: 2,
        maxChildren: 0,
        bed: "1 Double bed",
        sqft: 200,
        view: "Palm grove",
        total: 1,
        amenities: ["wifi", "hot_water"],
        images: [img("homestay", 2)],
        plans: [{ name: "Room only", mealPlan: "EP", price: rupees(2400), inclusions: ["Bicycles"] }],
      },
    ],
    nearby: [
      ["Benaulim Beach", "ATTRACTION", 0.2, "Quiet, wide sandy beach.", img("goa", 1)],
      ["Colva Beach", "ATTRACTION", 3, "Livelier beach with water sports."],
      ["Madgaon Railway Station", "TRANSPORT", 7, "Konkan Railway hub."],
    ],
  },
  {
    name: "Marine Bay Business Hotel",
    city: "mumbai",
    area: "Marine Drive",
    type: "HOTEL",
    tags: ["CORPORATE"],
    star: 5,
    short: "Sea-facing business hotel on Marine Drive with a rooftop infinity pool.",
    description:
      "An art deco landmark reborn as a 5-star business hotel. Wake up to views of the Queen's Necklace, work from ergonomic suites with 1 Gbps Wi-Fi and unwind in the rooftop infinity pool. Nariman Point offices are 5 minutes away.",
    highlights: ["Sea-facing rooms", "Rooftop infinity pool", "5 min to Nariman Point", "Club lounge with evening cocktails"],
    food: "Three restaurants including a coastal seafood grill and a rooftop bar.",
    address: "Netaji Subhash Chandra Bose Road, Marine Drive, Mumbai",
    pincode: "400020",
    lat: 18.9432,
    lng: 72.8236,
    policy: MODERATE,
    rules: HOUSE_RULES,
    amenities: ["wifi", "pool", "gym", "spa", "restaurant", "bar", "room_service", "lift", "meeting_room", "airport_transfer", "front_desk", "laundry"],
    featured: true,
    rank: 7,
    media: [
      I("hotel_exterior", 1, "EXTERIOR", "Hotel facade"),
      I("mumbai", 1, "VIEW", "Queen's Necklace"),
      I("pool", 3, "POOL", "Rooftop infinity pool"),
      I("room", 10, "ROOM", "Sea view king"),
      I("common_area", 3, "COMMON_AREA", "Club lounge"),
      I("bathroom", 0, "BATHROOM"),
      V(VIDEO.rooftopPool, "POOL", img("pool", 3), "Rooftop pool", 14),
      V(VIDEO.roomInterior, "ROOM_WALKTHROUGH", img("room", 10), "Sea view room", 12),
    ],
    rooms: [
      {
        name: "Deluxe City View",
        description: "Ergonomic workspace, Nespresso machine and blackout blinds.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King bed",
        sqft: 330,
        view: "City",
        total: 30,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "workdesk", "safe", "kettle"],
        images: [img("room", 11), img("bathroom", 1)],
        plans: [
          { name: "Room only", mealPlan: "EP", price: rupees(9800), inclusions: [] },
          { name: "Breakfast included", mealPlan: "CP", price: rupees(11200), inclusions: BREAKFAST },
        ],
      },
      {
        name: "Sea View King",
        description: "Floor-to-ceiling windows over the Arabian Sea.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King bed",
        sqft: 380,
        view: "Arabian Sea",
        total: 15,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "workdesk", "safe", "bathtub"],
        images: [img("room", 10), img("mumbai", 1)],
        plans: [
          { name: "Breakfast included", mealPlan: "CP", price: rupees(13500), inclusions: [...BREAKFAST, "Club lounge access"] },
          { name: "Advance purchase", mealPlan: "CP", price: rupees(12000), inclusions: BREAKFAST, refundable: false },
        ],
      },
    ],
    nearby: [
      ["Gateway of India", "ATTRACTION", 3.2, "Iconic 1924 arch monument.", img("attraction", 5)],
      ["Nariman Point", "BUSINESS", 1.5, "Financial district."],
      ["Churchgate Station", "TRANSPORT", 1.0, "Western Railway terminus."],
      ["Bombay Hospital", "HOSPITAL", 1.4, "24h emergency care."],
    ],
  },
  {
    name: "Misty Hills Pool Villa",
    city: "lonavala",
    area: "Tungarli",
    type: "VILLA",
    tags: ["FRIENDS", "FAMILY"],
    star: null,
    short: "5-bedroom hilltop villa with an infinity pool facing the Sahyadri valley.",
    description:
      "Perched above Tungarli lake, Misty Hills is a glass-and-stone villa made for weekend gatherings. The infinity pool overlooks the valley, the living room seats 14, and the lawn is lit with fairy lights for bonfire nights.",
    highlights: ["Valley-facing infinity pool", "Bonfire & barbecue", "Sleeps 14", "90 min from Mumbai"],
    food: "Chef on request (Maharashtrian, North Indian and barbecue menus); fully equipped kitchen.",
    address: "Tungarli Dam Road, Tungarli, Lonavala, Maharashtra",
    pincode: "410403",
    lat: 18.7616,
    lng: 73.3948,
    policy: MODERATE,
    rules: ["Music off by 10 PM (local rules)", "Maximum 14 guests including children", "Refundable damage deposit ₹15,000"],
    amenities: ["wifi", "private_pool", "kitchen", "parking", "caretaker", "bonfire", "garden", "power_backup", "kids_play"],
    recommended: true,
    featured: true,
    rank: 6,
    media: [
      I("villa_exterior", 3, "EXTERIOR", "Villa at dusk"),
      I("pool", 4, "POOL", "Infinity pool"),
      I("lonavala", 1, "VIEW", "Sahyadri valley"),
      I("room", 12, "ROOM", "Valley bedroom"),
      I("common_area", 4, "COMMON_AREA", "Living room"),
      I("bathroom", 2, "BATHROOM"),
      V(VIDEO.greenHills, "VIEW", img("lonavala", 1), "Monsoon in the valley", 18),
      V(VIDEO.poolTimelapse, "POOL", img("pool", 4), "Poolside day", 15),
    ],
    rooms: [
      {
        name: "Entire Villa (5 BHK)",
        description: "Whole villa with pool, lawn and caretaker for groups up to 14.",
        maxAdults: 12,
        maxChildren: 2,
        bed: "5 King beds + 2 extra mattresses",
        sqft: 5000,
        view: "Valley",
        total: 1,
        amenities: ["wifi", "ac", "tv", "hot_water", "kitchen", "private_pool", "balcony"],
        images: [img("villa_exterior", 4), img("pool", 5)],
        plans: [
          { name: "Villa only", mealPlan: "EP", price: rupees(32000), inclusions: ["Caretaker", "Bonfire wood"] },
          { name: "All meals by chef", mealPlan: "AP", price: rupees(45000), inclusions: ["Breakfast, lunch & dinner for 12", "Barbecue night"] },
        ],
      },
      {
        name: "3 BHK Wing",
        description: "Private wing with 3 bedrooms and shared pool timing.",
        maxAdults: 6,
        maxChildren: 2,
        bed: "3 King beds",
        sqft: 2200,
        view: "Valley",
        total: 1,
        amenities: ["wifi", "ac", "tv", "hot_water", "kitchen"],
        images: [img("room", 13)],
        plans: [{ name: "Wing only", mealPlan: "EP", price: rupees(18000), inclusions: ["Caretaker"] }],
      },
    ],
    nearby: [
      ["Tiger's Leap", "ATTRACTION", 6, "Cliff-top valley viewpoint."],
      ["Bhushi Dam", "ATTRACTION", 5, "Monsoon waterfall steps."],
      ["Lonavala Station", "TRANSPORT", 3.5, "Mumbai–Pune line."],
    ],
  },
  {
    name: "Green Acres Farmstay",
    city: "lonavala",
    area: "Pawna Lake",
    type: "FARMHOUSE",
    tags: ["FAMILY", "FRIENDS"],
    star: null,
    short: "A working organic farm by Pawna Lake with cottages, tractor rides and campfires.",
    description:
      "Spread over 12 acres of organic farmland near Pawna Lake, Green Acres has stone cottages, a farm-to-table kitchen and plenty of room for kids to run around. Join the morning milking, pick vegetables for lunch and end the day at the lakeside campfire.",
    highlights: ["12-acre organic farm", "Tractor rides & farm activities", "Lakeside campfire", "Farm-to-table meals"],
    food: "All meals from the farm kitchen: Maharashtrian thalis, wood-fired pizzas and fresh farm produce.",
    address: "Near Pawna Dam, Thakursai, Maval, Pune district",
    pincode: "410406",
    lat: 18.6743,
    lng: 73.4851,
    policy: FLEXIBLE,
    rules: ["Children must be supervised near farm animals", "No music after 10 PM"],
    amenities: ["wifi", "parking", "garden", "bonfire", "kids_play", "restaurant", "pet_friendly", "caretaker"],
    recommended: true,
    rank: 3,
    media: [
      I("farmhouse_nature", 0, "EXTERIOR", "Farm cottages"),
      I("farmhouse_nature", 1, "SURROUNDINGS", "Organic fields"),
      I("room", 14, "ROOM", "Stone cottage"),
      I("farmhouse_nature", 2, "COMMON_AREA", "Farm deck"),
      I("dining", 4, "DINING", "Farm-to-table lunch"),
      I("view", 7, "VIEW", "Pawna Lake"),
      V(VIDEO.lakeSunset, "VIEW", img("view", 7), "Evening at the lake", 20),
    ],
    rooms: [
      {
        name: "Stone Cottage",
        description: "Private cottage with a sit-out facing the fields.",
        maxAdults: 2,
        maxChildren: 2,
        bed: "1 King bed + 1 floor mattress",
        sqft: 350,
        view: "Farm",
        total: 5,
        amenities: ["wifi", "hot_water", "balcony"],
        images: [img("farmhouse_nature", 3), img("room", 14)],
        plans: [
          { name: "All meals", mealPlan: "AP", price: rupees(7500), inclusions: ["Breakfast, lunch & dinner", "Farm activities"] },
          { name: "Breakfast only", mealPlan: "CP", price: rupees(5200), inclusions: ["Farm breakfast"] },
        ],
      },
      {
        name: "Family Farmhouse Room",
        description: "Large room in the main farmhouse for families of four.",
        maxAdults: 4,
        maxChildren: 2,
        bed: "2 Queen beds",
        sqft: 450,
        view: "Garden",
        total: 2,
        amenities: ["wifi", "hot_water"],
        images: [img("farmhouse_nature", 4)],
        plans: [{ name: "All meals", mealPlan: "AP", price: rupees(10500), inclusions: ["All meals for 4", "Tractor ride"] }],
      },
    ],
    nearby: [
      ["Pawna Lake", "ATTRACTION", 1.2, "Camping and kayaking.", img("view", 7)],
      ["Tikona Fort", "ATTRACTION", 7, "Easy 2-hour trek."],
      ["Lohagad Fort", "ATTRACTION", 14, "Popular monsoon trek."],
    ],
  },
  {
    name: "Pine Cone Cottage",
    city: "manali",
    area: "Old Manali",
    type: "HOMESTAY",
    tags: ["COUPLES", "FRIENDS"],
    star: null,
    short: "Wooden Himalayan cottage in an apple orchard with snow-peak views.",
    description:
      "A traditional kath-kuni cottage of wood and stone in an Old Manali apple orchard. Hosts Tenzin and Meera serve Himachali breakfasts, light the bukhari on cold nights and know every trail in the valley.",
    highlights: ["Snow-peak views", "Apple orchard", "Bukhari-heated rooms", "Trek guidance by hosts"],
    food: "Home-cooked Himachali and Tibetan meals; cafes of Old Manali a 5-minute walk away.",
    address: "Manu Temple Road, Old Manali, Himachal Pradesh",
    pincode: "175131",
    lat: 32.2524,
    lng: 77.1818,
    policy: FLEXIBLE,
    rules: ["Shoes off inside the cottage", "No smoking indoors", "Quiet hours after 10 PM"],
    amenities: ["wifi", "parking", "garden", "bonfire", "couple_friendly", "caretaker", "power_backup"],
    featured: true,
    rank: 5,
    media: [
      I("homestay", 3, "EXTERIOR", "Wooden cottage"),
      I("manali", 1, "VIEW", "Snow peaks"),
      I("homestay", 4, "ROOM", "Attic bedroom"),
      I("view", 0, "SURROUNDINGS", "Himalayan valley"),
      I("dining", 5, "DINING", "Himachali breakfast"),
      I("bathroom", 4, "BATHROOM"),
      V(VIDEO.snowyMountains, "VIEW", img("manali", 1), "Morning fog over the peaks", 20),
      V(VIDEO.mountains, "SURROUNDINGS", img("view", 0), "The valley", 20),
    ],
    rooms: [
      {
        name: "Orchard Room",
        description: "Pine-panelled room with bukhari heater and orchard view.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 Queen bed",
        sqft: 210,
        view: "Orchard",
        total: 3,
        amenities: ["wifi", "hot_water", "kettle", "balcony"],
        images: [img("homestay", 4), img("room", 15)],
        plans: [
          { name: "With breakfast", mealPlan: "CP", price: rupees(2800), inclusions: ["Himachali breakfast"] },
          { name: "Breakfast + dinner", mealPlan: "MAP", price: rupees(3600), inclusions: ["Breakfast", "Home-cooked dinner"] },
        ],
      },
      {
        name: "Attic Snow-View Loft",
        description: "Loft with a skylight and panoramic Himalayan view.",
        maxAdults: 3,
        maxChildren: 1,
        bed: "1 King bed + single",
        sqft: 300,
        view: "Snow peaks",
        total: 1,
        amenities: ["wifi", "hot_water", "kettle"],
        images: [img("homestay", 5)],
        plans: [{ name: "With breakfast", mealPlan: "CP", price: rupees(4200), inclusions: ["Himachali breakfast"] }],
      },
    ],
    nearby: [
      ["Hadimba Temple", "ATTRACTION", 1.8, "16th-century cedar-forest temple.", img("attraction", 1)],
      ["Mall Road", "SHOPPING", 2.5, "Shops and cafes."],
      ["Solang Valley", "ATTRACTION", 13, "Paragliding and snow sports."],
      ["Jogini Falls", "ATTRACTION", 4, "Waterfall trek from Vashisht."],
    ],
  },
  {
    name: "Ganga Riverside Retreat",
    city: "rishikesh",
    area: "Tapovan",
    type: "HOTEL",
    tags: ["FAMILY", "COUPLES"],
    star: 4,
    short: "Riverside wellness hotel with a yoga shala, spa and Ganga-view rooms.",
    description:
      "Set on the banks of the Ganga in Tapovan, the retreat pairs comfortable rooms with daily yoga, an Ayurvedic spa and sattvic cuisine. Watch the evening aarti from the riverside deck.",
    highlights: ["Daily yoga sessions", "Ayurvedic spa", "Ganga-view rooms", "Walk to Laxman Jhula"],
    food: "Sattvic vegetarian restaurant with Ganga views; juice bar.",
    address: "Badrinath Road, Tapovan, Rishikesh, Uttarakhand",
    pincode: "249192",
    lat: 30.1308,
    lng: 78.3269,
    policy: FLEXIBLE,
    rules: [...HOUSE_RULES, "Vegetarian property — no non-veg food or alcohol"],
    amenities: ["wifi", "spa", "restaurant", "room_service", "garden", "parking", "front_desk", "lift"],
    recommended: true,
    rank: 4,
    media: [
      I("hotel_exterior", 2, "EXTERIOR", "Riverside retreat"),
      I("rishikesh", 1, "VIEW", "The Ganga"),
      I("room", 16, "ROOM", "Ganga view room"),
      I("common_area", 5, "COMMON_AREA", "Yoga shala"),
      I("dining", 6, "DINING", "Sattvic thali"),
      I("pool", 5, "POOL", "Plunge pool"),
      V(VIDEO.roomBreakfast, "ROOM_WALKTHROUGH", img("room", 16), "Mornings at the retreat", 25),
    ],
    rooms: [
      {
        name: "Garden Room",
        description: "Ground-floor room opening onto the garden.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King or 2 Twin beds",
        sqft: 250,
        view: "Garden",
        total: 12,
        amenities: ["wifi", "ac", "tv", "hot_water", "kettle"],
        images: [img("room", 1), img("common_area", 5)],
        plans: [
          { name: "With breakfast", mealPlan: "CP", price: rupees(3800), inclusions: ["Sattvic breakfast", "Morning yoga"] },
          { name: "Wellness package", mealPlan: "AP", price: rupees(6200), inclusions: ["All sattvic meals", "Yoga twice daily", "1 spa therapy"] },
        ],
      },
      {
        name: "Ganga View Room",
        description: "Private balcony facing the river and the hills.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 King bed",
        sqft: 290,
        view: "Ganga",
        total: 8,
        amenities: ["wifi", "ac", "tv", "hot_water", "kettle", "balcony"],
        images: [img("room", 16), img("rishikesh", 1)],
        plans: [{ name: "With breakfast", mealPlan: "CP", price: rupees(5200), inclusions: ["Sattvic breakfast", "Morning yoga"] }],
      },
    ],
    nearby: [
      ["Laxman Jhula", "ATTRACTION", 0.8, "Iconic suspension bridge.", img("attraction", 6)],
      ["Triveni Ghat", "ATTRACTION", 4, "Evening Ganga aarti."],
      ["Beatles Ashram", "ATTRACTION", 3, "Graffiti-filled ashram ruins."],
    ],
  },
  {
    name: "Chandni Chowk Heritage Haveli",
    city: "delhi",
    area: "Old Delhi",
    type: "HERITAGE",
    tags: ["COUPLES", "FAMILY", "CORPORATE"],
    star: 4,
    short: "A 200-year-old Mughal-era haveli in the lanes of Old Delhi with a rooftop view of Jama Masjid.",
    description:
      "Tucked into a quiet lane off Chandni Chowk, this restored haveli has 10 rooms around a sandstone courtyard, a rooftop with views of Jama Masjid and guided food walks through Old Delhi each evening.",
    highlights: ["Rooftop view of Jama Masjid", "Guided Old Delhi food walk", "Metro 5 min walk", "Restored Mughal architecture"],
    food: "Rooftop cafe with Mughlai and North Indian menus.",
    address: "Kucha Pati Ram, Chandni Chowk, Old Delhi",
    pincode: "110006",
    lat: 28.6506,
    lng: 77.2303,
    policy: MODERATE,
    rules: [...HOUSE_RULES, "Cars cannot enter the lane — we arrange a cycle-rickshaw pick-up"],
    amenities: ["wifi", "restaurant", "front_desk", "room_service", "couple_friendly", "laundry", "airport_transfer"],
    rank: 2,
    media: [
      I("heritage", 6, "EXTERIOR", "Haveli gate"),
      I("heritage", 7, "COMMON_AREA", "Sandstone courtyard"),
      I("room", 3, "ROOM", "Courtyard room"),
      I("delhi", 1, "SURROUNDINGS", "Old Delhi"),
      I("bathroom", 6, "BATHROOM"),
      I("dining", 7, "DINING", "Rooftop cafe"),
      V(VIDEO.breakfast, "DINING", img("dining", 7), "Breakfast on the rooftop", 15),
    ],
    rooms: [
      {
        name: "Courtyard Room",
        description: "Opens onto the central courtyard; antique furniture.",
        maxAdults: 2,
        maxChildren: 1,
        bed: "1 Queen bed",
        sqft: 230,
        view: "Courtyard",
        total: 6,
        amenities: ["wifi", "ac", "tv", "hot_water", "kettle"],
        images: [img("room", 3), img("heritage", 7)],
        plans: [
          { name: "With breakfast", mealPlan: "CP", price: rupees(5400), inclusions: BREAKFAST },
          { name: "Breakfast + food walk", mealPlan: "CP", price: rupees(6900), inclusions: [...BREAKFAST, "Evening food walk for 2"] },
        ],
      },
      {
        name: "Jharokha Suite",
        description: "Upper-floor suite with a jharokha overlooking the lane.",
        maxAdults: 3,
        maxChildren: 1,
        bed: "1 King bed + sofa bed",
        sqft: 400,
        view: "Jama Masjid",
        total: 2,
        amenities: ["wifi", "ac", "tv", "hot_water", "minibar", "bathtub"],
        images: [img("heritage", 8)],
        plans: [{ name: "With breakfast", mealPlan: "CP", price: rupees(8800), inclusions: BREAKFAST }],
      },
    ],
    nearby: [
      ["Jama Masjid", "ATTRACTION", 0.6, "India's largest mosque.", img("attraction", 4)],
      ["Red Fort", "ATTRACTION", 1.2, "UNESCO World Heritage Site."],
      ["Chawri Bazar Metro", "TRANSPORT", 0.4, "Yellow Line metro station."],
      ["Paranthe Wali Gali", "FOOD", 0.3, "Legendary fried parathas since 1872."],
    ],
  },
];

const EXPERIENCES = [
  {
    title: "Sunrise Hot Air Balloon over Jaipur",
    city: "jaipur",
    property: "The Pink Pearl Haveli",
    short: "Float over Amber Fort and the Aravalli hills at sunrise.",
    story: "Lift off at dawn and drift over villages, forts and lakes as the Pink City wakes up below you. Flights last about an hour and end with a celebratory breakfast.",
    location: "Amer, Jaipur",
    meetingPoint: "Pick-up from your hotel at 5:30 AM",
    lat: 26.9855,
    lng: 75.8513,
    duration: 180,
    price: rupees(14500),
    suitableFor: ["Couples", "Families with kids 8+", "Photographers"],
    included: ["Hotel pick-up & drop", "1-hour flight", "Breakfast", "Flight certificate"],
    excluded: ["Personal expenses"],
    host: "SkyWaltz Balloon Safaris",
    images: [img("experience", 0), img("jaipur", 1)],
    video: null as string | null,
  },
  {
    title: "Sunset Boat Ride on Lake Pichola",
    city: "udaipur",
    property: "Pichola Lake Palace Residency",
    short: "Glide past City Palace and Jag Mandir as the sun sets.",
    story: "A slow, 1-hour boat ride across Lake Pichola with a stop at Jag Mandir island palace — the most magical hour in Udaipur.",
    location: "Lal Ghat, Udaipur",
    meetingPoint: "Residency private jetty",
    lat: 24.5786,
    lng: 73.6832,
    duration: 60,
    price: rupees(1200),
    suitableFor: ["Couples", "Families", "Seniors"],
    included: ["Boat ride", "Stop at Jag Mandir", "Life jackets"],
    excluded: ["Food & drinks"],
    host: "Pichola Boat Club",
    images: [img("experience", 1), img("udaipur", 0)],
    video: VIDEO.lakeSunset as string | null,
  },
  {
    title: "Old Delhi Food Walk",
    city: "delhi",
    property: "Chandni Chowk Heritage Haveli",
    short: "Parathas, jalebis, kebabs and chaat — 10 tastings in 3 hours.",
    story: "Follow a local food writer through the lanes of Chandni Chowk, tasting recipes that have been passed down for generations.",
    location: "Chandni Chowk, Old Delhi",
    meetingPoint: "Chawri Bazar metro gate 2",
    lat: 28.6497,
    lng: 77.2265,
    duration: 180,
    price: rupees(1800),
    suitableFor: ["Food lovers", "First-time visitors"],
    included: ["10 tastings", "Bottled water", "Local guide"],
    excluded: ["Transport to meeting point"],
    host: "Delhi Food Trails",
    images: [img("experience", 3), img("experience", 8)],
    video: null,
  },
  {
    title: "Sunrise Yoga by the Ganga",
    city: "rishikesh",
    property: "Ganga Riverside Retreat",
    short: "A gentle 90-minute hatha session on a riverside deck.",
    story: "Start the day with pranayama and hatha yoga as the sun rises over the Himalayan foothills, followed by herbal tea.",
    location: "Tapovan, Rishikesh",
    meetingPoint: "Riverside deck, Ganga Riverside Retreat",
    lat: 30.1308,
    lng: 78.3269,
    duration: 90,
    price: rupees(800),
    suitableFor: ["Beginners", "All ages"],
    included: ["Yoga mat", "Herbal tea"],
    excluded: [],
    host: "Acharya Devesh",
    images: [img("experience", 4), img("rishikesh", 0)],
    video: null,
  },
  {
    title: "White-Water Rafting in Shivpuri",
    city: "rishikesh",
    property: null as string | null,
    short: "16 km of Grade III rapids on the Ganga.",
    story: "Tackle rapids like 'Roller Coaster' and 'Golf Course' with certified guides, then float through the calm stretches back to Rishikesh.",
    location: "Shivpuri to Rishikesh",
    meetingPoint: "Shivpuri rafting point",
    lat: 30.1447,
    lng: 78.3935,
    duration: 180,
    price: rupees(1500),
    suitableFor: ["Friends", "Adventure seekers 14+"],
    included: ["Safety gear", "Certified guide", "Transport back to Rishikesh"],
    excluded: ["GoPro rental"],
    host: "Ganga Rapids Co.",
    images: [img("experience", 5), img("experience", 6)],
    video: null,
  },
  {
    title: "Jogini Falls Trek from Old Manali",
    city: "manali",
    property: "Pine Cone Cottage",
    short: "A half-day trek through pine forests to a 150-ft waterfall.",
    story: "Walk through Vashisht village and deodar forests to Jogini Falls with a local guide. Easy to moderate, with chai breaks along the way.",
    location: "Vashisht, Manali",
    meetingPoint: "Vashisht temple",
    lat: 32.2689,
    lng: 77.1882,
    duration: 240,
    price: rupees(1100),
    suitableFor: ["Friends", "Couples", "Families with kids 10+"],
    included: ["Local guide", "Chai & snacks"],
    excluded: ["Trekking shoes"],
    host: "Himalayan Trails Collective",
    images: [img("experience", 7), img("manali", 0)],
    video: VIDEO.mountains as string | null,
  },
];

const COLLECTIONS = [
  {
    title: "Romantic Getaways",
    description: "Lakeside palaces, beach homestays and mountain cottages made for two.",
    city: null as string | null,
    cover: img("udaipur", 1),
    properties: ["Pichola Lake Palace Residency", "The Pink Pearl Haveli", "Palm Grove Beach Homestay", "Pine Cone Cottage"],
  },
  {
    title: "Private Pool Villas",
    description: "Villas with pools all to yourselves — for families and friends.",
    city: null,
    cover: img("pool", 1),
    properties: ["Casa Azul Private Pool Villa", "Misty Hills Pool Villa"],
  },
  {
    title: "Heritage Havelis & Palaces",
    description: "Sleep in history — restored havelis and palace residencies.",
    city: null,
    cover: img("heritage", 0),
    properties: ["The Pink Pearl Haveli", "Pichola Lake Palace Residency", "Chandni Chowk Heritage Haveli"],
  },
  {
    title: "Weekend Escapes from Mumbai",
    description: "Villas and farm stays within a 3-hour drive of Mumbai.",
    city: "lonavala" as string | null,
    cover: img("lonavala", 0),
    properties: ["Misty Hills Pool Villa", "Green Acres Farmstay", "Marine Bay Business Hotel"],
  },
];

const BANNERS = [
  {
    title: "Private pool villas in Goa",
    subtitle: "Whole villas for your group, from ₹24,000 a night",
    videoUrl: VIDEO.resortPoolSea,
    posterUrl: img("pool", 0),
    ctaLabel: "Explore Goa villas",
    ctaUrl: "/search?city=goa&type=VILLA",
    property: "Casa Azul Private Pool Villa",
  },
  {
    title: "Wake up to the Himalayas",
    subtitle: "Cottages and homestays in Manali",
    videoUrl: VIDEO.snowyMountains,
    posterUrl: img("manali", 0),
    ctaLabel: "Find mountain stays",
    ctaUrl: "/search?city=manali",
    property: "Pine Cone Cottage",
  },
  {
    title: "Sunsets by the sea",
    subtitle: "See every stay on video before you book",
    videoUrl: VIDEO.sunsetTerrace,
    posterUrl: img("view", 3),
    ctaLabel: "Watch stay videos",
    ctaUrl: "/videos",
    property: null as string | null,
  },
];

const REVIEWS: [property: string, reviewer: number, rating: number, title: string, body: string, monthsAgo: number, reply?: string][] = [
  ["The Pink Pearl Haveli", 0, 5, "Like staying in a palace", "The frescoes, the rooftop view and the folk music in the evening — unforgettable. Staff organised a great heritage walk.", 2, "Thank you Ananya! We'd love to host you again."],
  ["The Pink Pearl Haveli", 1, 4, "Beautiful, a bit noisy", "Gorgeous haveli right in the bazaar. Expect some street noise in the morning but the location is unbeatable.", 4],
  ["Pichola Lake Palace Residency", 2, 5, "Most romantic stay ever", "Our lake view room had the best sunset view in Udaipur. The candle-lit dinner was magical.", 1, "So glad you enjoyed your anniversary with us!"],
  ["Casa Azul Private Pool Villa", 3, 5, "Perfect for our group", "Eight of us, a private pool and a cook who made the best fish curry. Super clean villa.", 3],
  ["Casa Azul Private Pool Villa", 1, 4, "Great villa, book the cook", "Lovely pool and garden. A bit of a drive to the beach but worth it.", 5],
  ["Misty Hills Pool Villa", 0, 5, "Monsoon magic", "The infinity pool with clouds rolling through the valley was surreal. Caretaker was very helpful.", 2],
  ["Pine Cone Cottage", 2, 5, "Cosy and warm", "Tenzin and Meera made us feel at home. Breakfasts were delicious and the view of the peaks is stunning.", 6],
  ["Ganga Riverside Retreat", 3, 4, "Peaceful and healthy", "Loved the morning yoga and sattvic food. Rooms are simple but comfortable.", 3],
  ["Marine Bay Business Hotel", 1, 5, "Best business hotel in South Mumbai", "Fast Wi-Fi, sea view from the desk and the rooftop pool after meetings. Will be back.", 1],
  ["Green Acres Farmstay", 0, 4, "Kids loved it", "Tractor rides, cows, campfire — our kids didn't want to leave. Food was fresh and tasty.", 4],
];

// ─── Seeding ──────────────────────────────────────────────────────────────────

const lower = (s: string) => s.toLowerCase();
const extKey = () => `external/demo/${crypto.randomUUID()}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function findDemoPartnerId() {
  const [row] = await db
    .select({ partnerId: partnerUsers.partnerId })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(sql`lower(${users.email}) = ${DEMO_PARTNER_EMAIL}`);
  return row?.partnerId ?? null;
}

async function reset() {
  const partnerId = await findDemoPartnerId();
  const expSlugs = EXPERIENCES.map((e) => slugify(e.title));
  const colSlugs = COLLECTIONS.map((c) => slugify(c.title));
  await db.transaction(async (tx) => {
    if (partnerId) {
      const props = await tx.select({ id: properties.id }).from(properties).where(eq(properties.partnerId, partnerId));
      const propIds = props.map((p) => p.id);
      if (propIds.length) {
        // Booking-side rows created while testing against demo data (Backend B tables).
        await tx.execute(sql`DELETE FROM ledger_entries WHERE partner_id = ${partnerId}`);
        await tx.execute(sql`DELETE FROM refunds WHERE booking_id IN (SELECT id FROM bookings WHERE partner_id = ${partnerId})`);
        await tx.execute(sql`DELETE FROM payment_transfers WHERE partner_id = ${partnerId}`);
        await tx.execute(sql`DELETE FROM payouts WHERE partner_id = ${partnerId}`);
        await tx.execute(sql`DELETE FROM reviews WHERE property_id IN ${propIds}`);
        await tx.execute(sql`DELETE FROM bookings WHERE partner_id = ${partnerId}`);
        await tx.execute(sql`DELETE FROM settlements WHERE partner_id = ${partnerId}`);
        await tx.execute(sql`
          DELETE FROM media WHERE
            (owner_type = 'PROPERTY' AND owner_id IN ${propIds})
            OR (owner_type = 'ROOM_TYPE' AND owner_id IN (SELECT id FROM room_types WHERE property_id IN ${propIds}))
            OR (owner_type = 'NEARBY_PLACE' AND owner_id IN (SELECT id FROM nearby_places WHERE property_id IN ${propIds}))`);
        await tx.delete(properties).where(inArray(properties.id, propIds));
      }
      await tx.delete(partners).where(eq(partners.id, partnerId));
    }
    const exps = await tx.select({ id: experiences.id }).from(experiences).where(inArray(experiences.slug, expSlugs));
    if (exps.length) {
      await tx.execute(sql`DELETE FROM media WHERE owner_type = 'EXPERIENCE' AND owner_id IN ${exps.map((e) => e.id)}`);
      await tx.delete(experiences).where(inArray(experiences.id, exps.map((e) => e.id)));
    }
    await tx.delete(collections).where(inArray(collections.slug, colSlugs));
    await tx.delete(banners).where(inArray(banners.title, BANNERS.map((b) => b.title)));
    const demoUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, DEMO_USER_EMAILS));
    if (demoUsers.length) {
      const ids = demoUsers.map((u) => u.id);
      await tx.execute(sql`DELETE FROM reviews WHERE user_id IN ${ids}`);
      await tx.execute(sql`UPDATE bookings SET user_id = NULL WHERE user_id IN ${ids}`);
      await tx.delete(users).where(inArray(users.id, ids));
    }
  });
  console.log("• demo data removed");
}

async function seed() {
  const cityRows = await db.select().from(cities);
  const cityBySlug = new Map(cityRows.map((c) => [c.slug, c]));
  const missing = [...new Set(PROPERTIES.map((p) => p.city))].filter((s) => !cityBySlug.has(s));
  if (missing.length) throw new Error(`Base cities missing (${missing.join(", ")}) — run \`bun run seed\` first`);
  const amenityRows = await db.select().from(amenities);
  const amenityByCode = new Map(amenityRows.map((a) => [a.code, a]));
  const amenityIds = (codes: string[]) =>
    codes.map((c) => {
      const a = amenityByCode.get(c);
      if (!a) throw new Error(`Amenity ${c} missing — run \`bun run seed\` first`);
      return a.id;
    });

  const [partnerHash, guestHash] = await Promise.all([
    Bun.password.hash(DEMO_PARTNER_PASSWORD),
    Bun.password.hash(DEMO_GUEST_PASSWORD),
  ]);

  await db.transaction(async (tx) => {
    // Cities: cover images + guides (only fill blanks), areas.
    for (const [slug, content] of Object.entries(CITY_CONTENT)) {
      const c = cityBySlug.get(slug);
      if (!c) continue;
      await tx
        .update(cities)
        .set({
          coverImageUrl: c.coverImageUrl ?? content.cover,
          travelInfo: c.travelInfo ?? content.travelInfo,
          foodGuide: c.foodGuide ?? content.foodGuide,
        })
        .where(eq(cities.id, c.id));
    }
    await tx
      .insert(areas)
      .values(
        Object.entries(AREAS).flatMap(([slug, list]) =>
          cityBySlug.has(slug)
            ? list.map(([name, description, isRecommended]) => ({
                cityId: cityBySlug.get(slug)!.id,
                name,
                slug: slugify(name),
                description,
                isRecommended,
              }))
            : [],
        ),
      )
      .onConflictDoNothing();
    const areaRows = await tx.select().from(areas);
    const areaId = (citySlug: string, name: string) =>
      areaRows.find((a) => a.cityId === cityBySlug.get(citySlug)!.id && a.slug === slugify(name))?.id ?? null;

    // Users: partner owner, demo guest, reviewers.
    const insertedUsers = await tx
      .insert(users)
      .values([
        { name: "Demo Partner", email: DEMO_PARTNER_EMAIL, phone: "+919000000001", passwordHash: partnerHash, role: "PARTNER_OWNER", emailVerified: true, mustChangePassword: false },
        { name: "Demo Guest", email: DEMO_GUEST_EMAIL, phone: "+919000000002", passwordHash: guestHash, role: "CUSTOMER", emailVerified: true },
        ...REVIEWERS.map(([name, email]) => ({ name, email, role: "CUSTOMER" as const, emailVerified: true })),
      ])
      .returning();
    const userByEmail = new Map(insertedUsers.map((u) => [lower(u.email!), u]));
    const owner = userByEmail.get(DEMO_PARTNER_EMAIL)!;

    const [partner] = await tx
      .insert(partners)
      .values({
        legalName: "BookMeStays Demo Hospitality Pvt Ltd",
        displayName: "BookMeStays Demo Stays",
        contactName: "Demo Partner",
        email: DEMO_PARTNER_EMAIL,
        phone: "+919000000001",
        address: "12 MG Road, Bengaluru, Karnataka 560001",
        gstin: "29ABCDE1234F1Z5",
        pan: "ABCDE1234F",
        bankAccountName: "BookMeStays Demo Hospitality Pvt Ltd",
        bankAccountNumberEnc: encrypt("50100123456789"),
        bankAccountLast4: "6789",
        bankIfsc: "HDFC0000123",
        kycStatus: "VERIFIED",
        kycNotes: "Demo partner — auto verified",
        settlementCycle: "WEEKLY",
        settlementDayOfWeek: 1,
        settlementDelayDays: 3,
        defaultCommissionType: "PERCENT",
        defaultCommissionValue: 1500,
        defaultCancellationPolicy: FLEXIBLE,
        defaultTerms: "Guests must carry a valid government photo ID. The property may refuse check-in to guests without ID.",
      })
      .returning();
    await tx.insert(partnerUsers).values({ partnerId: partner.id, userId: owner.id, permissions: [] });

    // Properties
    const now = new Date();
    const propRows = await tx
      .insert(properties)
      .values(
        PROPERTIES.map((p, i) => ({
          partnerId: partner.id,
          name: p.name,
          slug: slugify(`${p.name} ${cityBySlug.get(p.city)!.name}`),
          type: p.type,
          travelTags: p.tags,
          starRating: p.star,
          shortDescription: p.short,
          description: p.description,
          highlights: p.highlights,
          foodAndDining: p.food,
          cityId: cityBySlug.get(p.city)!.id,
          areaId: areaId(p.city, p.area),
          address: p.address,
          pincode: p.pincode,
          lat: p.lat,
          lng: p.lng,
          cancellationPolicy: p.policy,
          houseRules: p.rules,
          terms: "Guests must carry a valid government photo ID. Early check-in and late check-out subject to availability.",
          contactPhone: "+919000000001",
          contactEmail: DEMO_PARTNER_EMAIL,
          status: "LIVE" as const,
          isFeatured: !!p.featured,
          isRecommended: !!p.recommended,
          curationRank: p.rank ?? 0,
          seo: { title: `${p.name} — ${cityBySlug.get(p.city)!.name} | BookMeStays`, description: p.short },
          publishedAt: new Date(now.getTime() - (PROPERTIES.length - i) * 86_400_000),
        })),
      )
      .returning();
    const propByName = new Map(propRows.map((r) => [r.name, r]));

    await tx.insert(propertyAmenities).values(
      PROPERTIES.flatMap((p) => amenityIds(p.amenities).map((amenityId) => ({ propertyId: propByName.get(p.name)!.id, amenityId }))),
    );

    // Room types
    const rtSpecs = PROPERTIES.flatMap((p) => p.rooms.map((r, sort) => ({ p, r, sort })));
    const rtRows = await tx
      .insert(roomTypes)
      .values(
        rtSpecs.map(({ p, r, sort }) => ({
          propertyId: propByName.get(p.name)!.id,
          name: r.name,
          description: r.description,
          maxAdults: r.maxAdults,
          maxChildren: r.maxChildren,
          maxOccupancy: r.maxAdults + r.maxChildren,
          bedConfig: r.bed,
          sizeSqft: r.sqft,
          viewType: r.view,
          totalRooms: r.total,
          basePrice: Math.min(...r.plans.map((pl) => pl.price)),
          status: "ACTIVE" as const,
          sort,
        })),
      )
      .returning();
    const rtId = (propertyName: string, roomName: string) =>
      rtRows.find((r) => r.propertyId === propByName.get(propertyName)!.id && r.name === roomName)!.id;

    await tx.insert(ratePlans).values(
      rtSpecs.flatMap(({ p, r }) =>
        r.plans.map((pl, sort) => ({
          roomTypeId: rtId(p.name, r.name),
          name: pl.name,
          mealPlan: pl.mealPlan,
          inclusions: pl.inclusions,
          isRefundable: pl.refundable !== false,
          cancellationPolicy: pl.refundable === false ? NON_REFUNDABLE : null,
          basePrice: pl.price,
          extraAdultPrice: Math.round(pl.price * 0.2 / 100) * 100,
          extraChildPrice: Math.round(pl.price * 0.1 / 100) * 100,
          sort,
        })),
      ),
    );
    await tx.insert(roomTypeAmenities).values(
      rtSpecs.flatMap(({ p, r }) => amenityIds(r.amenities).map((amenityId) => ({ roomTypeId: rtId(p.name, r.name), amenityId }))),
    );

    // Nearby places
    const nearbySpecs = PROPERTIES.flatMap((p) => p.nearby.map((n, sort) => ({ p, n, sort })));
    const nearbyRows = await tx
      .insert(nearbyPlaces)
      .values(
        nearbySpecs.map(({ p, n: [name, category, km, description], sort }) => ({
          propertyId: propByName.get(p.name)!.id,
          name,
          category,
          distanceKm: km,
          description,
          sort,
        })),
      )
      .returning();

    // Media (property, room type, nearby) — external URLs, no stored object.
    const mediaValues: (typeof media.$inferInsert)[] = [];
    for (const p of PROPERTIES) {
      const pid = propByName.get(p.name)!.id;
      let imageSort = 0;
      p.media.forEach((m, i) =>
        mediaValues.push({
          ownerType: "PROPERTY",
          ownerId: pid,
          kind: m.kind,
          s3Key: extKey(),
          url: m.url,
          posterUrl: m.posterUrl ?? null,
          tag: m.tag,
          title: m.title ?? null,
          durationSec: m.durationSec ?? null,
          width: m.kind === "IMAGE" ? 1600 : 1280,
          height: m.kind === "IMAGE" ? 1067 : 720,
          mimeType: m.kind === "IMAGE" ? "image/jpeg" : "video/mp4",
          sort: i,
          isCover: m.kind === "IMAGE" ? imageSort++ === 0 : i === p.media.findIndex((x) => x.kind === "VIDEO"),
          status: "READY",
        }),
      );
      for (const r of p.rooms)
        r.images.forEach((url, i) =>
          mediaValues.push({
            ownerType: "ROOM_TYPE",
            ownerId: rtId(p.name, r.name),
            kind: "IMAGE",
            s3Key: extKey(),
            url,
            tag: i === 0 ? "ROOM" : "OTHER",
            mimeType: "image/jpeg",
            sort: i,
            isCover: i === 0,
            status: "READY",
          }),
        );
    }
    nearbySpecs.forEach(({ n }, i) => {
      if (n[4])
        mediaValues.push({
          ownerType: "NEARBY_PLACE",
          ownerId: nearbyRows[i].id,
          kind: "IMAGE",
          s3Key: extKey(),
          url: n[4],
          tag: "SURROUNDINGS",
          mimeType: "image/jpeg",
          isCover: true,
          status: "READY",
        });
    });

    // Experiences
    const expRows = await tx
      .insert(experiences)
      .values(
        EXPERIENCES.map((e, sort) => ({
          title: e.title,
          slug: slugify(e.title),
          cityId: cityBySlug.get(e.city)!.id,
          propertyId: e.property ? propByName.get(e.property)!.id : null,
          shortDescription: e.short,
          story: e.story,
          location: e.location,
          meetingPoint: e.meetingPoint,
          lat: e.lat,
          lng: e.lng,
          durationMinutes: e.duration,
          price: e.price,
          suitableFor: e.suitableFor,
          included: e.included,
          excluded: e.excluded,
          hostName: e.host,
          hostInfo: `${e.host} is a verified BookMeStays experience partner.`,
          availabilityNote: "Runs daily, subject to weather. Book at least 24 hours in advance.",
          isBookable: false,
          coverImageUrl: e.images[0],
          ratingAvg: 4.6 + (sort % 4) / 10,
          ratingCount: 20 + sort * 7,
          sort,
          seo: { title: `${e.title} | BookMeStays`, description: e.short },
        })),
      )
      .returning();
    EXPERIENCES.forEach((e, i) => {
      e.images.forEach((url, sort) =>
        mediaValues.push({
          ownerType: "EXPERIENCE",
          ownerId: expRows[i].id,
          kind: "IMAGE",
          s3Key: extKey(),
          url,
          tag: "EXPERIENCE",
          mimeType: "image/jpeg",
          sort,
          isCover: sort === 0,
          status: "READY",
        }),
      );
      if (e.video)
        mediaValues.push({
          ownerType: "EXPERIENCE",
          ownerId: expRows[i].id,
          kind: "VIDEO",
          s3Key: extKey(),
          url: e.video,
          posterUrl: e.images[0],
          tag: "EXPERIENCE",
          mimeType: "video/mp4",
          durationSec: 20,
          sort: e.images.length,
          status: "READY",
        });
    });
    await tx.insert(media).values(mediaValues);

    // Collections
    const colRows = await tx
      .insert(collections)
      .values(
        COLLECTIONS.map((c, sort) => ({
          title: c.title,
          slug: slugify(c.title),
          description: c.description,
          cityId: c.city ? cityBySlug.get(c.city)!.id : null,
          coverImageUrl: c.cover,
          sort,
        })),
      )
      .returning();
    await tx.insert(collectionItems).values(
      COLLECTIONS.flatMap((c, i) => c.properties.map((name, sort) => ({ collectionId: colRows[i].id, propertyId: propByName.get(name)!.id, sort }))),
    );

    // Hero banners
    await tx.insert(banners).values(
      BANNERS.map((b, sort) => ({
        title: b.title,
        subtitle: b.subtitle,
        videoUrl: b.videoUrl,
        posterUrl: b.posterUrl,
        ctaLabel: b.ctaLabel,
        ctaUrl: b.ctaUrl,
        propertyId: b.property ? propByName.get(b.property)!.id : null,
        sort,
      })),
    );

    // Reviews (published)
    await tx.insert(reviews).values(
      REVIEWS.map(([property, reviewer, rating, title, body, monthsAgo, reply]) => ({
        userId: userByEmail.get(REVIEWERS[reviewer][1])!.id,
        propertyId: propByName.get(property)!.id,
        rating,
        title,
        body,
        status: "PUBLISHED" as const,
        partnerReply: reply ?? null,
        partnerRepliedAt: reply ? daysAgo(monthsAgo * 30 - 2) : null,
        createdAt: daysAgo(monthsAgo * 30),
      })),
    );

    // Denormalised fields: starting price, rating, cover / preview video.
    const ids = propRows.map((p) => p.id);
    await tx.execute(sql`
      UPDATE properties p SET
        starting_price = (
          SELECT min(rp.base_price) FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
          WHERE rt.property_id = p.id AND rt.status = 'ACTIVE' AND rp.is_active
        ),
        rating_avg = coalesce((SELECT round(avg(rating)::numeric, 1)::float8 FROM reviews r WHERE r.property_id = p.id AND r.status = 'PUBLISHED'), 0),
        rating_count = (SELECT count(*)::int FROM reviews r WHERE r.property_id = p.id AND r.status = 'PUBLISHED'),
        cover_image_url = (SELECT url FROM media m WHERE m.owner_type = 'PROPERTY' AND m.owner_id = p.id AND m.kind = 'IMAGE' ORDER BY m.is_cover DESC, m.sort LIMIT 1),
        preview_video_url = (SELECT url FROM media m WHERE m.owner_type = 'PROPERTY' AND m.owner_id = p.id AND m.kind = 'VIDEO' ORDER BY m.is_cover DESC, m.sort LIMIT 1),
        preview_video_poster_url = (SELECT poster_url FROM media m WHERE m.owner_type = 'PROPERTY' AND m.owner_id = p.id AND m.kind = 'VIDEO' ORDER BY m.is_cover DESC, m.sort LIMIT 1)
      WHERE p.id IN ${ids}
    `);
    console.log(
      `• demo partner, ${propRows.length} properties, ${rtRows.length} room types, ${mediaValues.length} media, ` +
        `${expRows.length} experiences, ${colRows.length} collections, ${BANNERS.length} banners, ${REVIEWS.length} reviews`,
    );
  });
}

const doReset = process.argv.includes("--reset");
if (doReset) await reset();
else if (await findDemoPartnerId()) {
  console.log("• demo data already present — skipping (use `bun run seed:demo --reset` to recreate)");
  process.exit(0);
}
await seed();
console.log(`✅ demo seed complete
   partner login:  ${DEMO_PARTNER_EMAIL} / ${DEMO_PARTNER_PASSWORD}
   guest login:    ${DEMO_GUEST_EMAIL} / ${DEMO_GUEST_PASSWORD}`);
process.exit(0);
