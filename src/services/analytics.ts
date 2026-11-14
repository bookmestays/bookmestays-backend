// Site analytics: first-party event ingestion (POST /public/analytics) and the admin
// "Site analytics" report (GET /admin/analytics) — visitors, traffic sources, locations,
// devices, top pages, the booking funnel and problems guests ran into.
import { and, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { analyticsEvents, properties } from "../db/schema";
import { addDays, todayIST } from "../lib/utils";

// ─── Ingestion ────────────────────────────────────────────────────────────────

export type IncomingEvent = {
  name: string;
  sessionId?: string;
  visitorId?: string;
  path?: string;
  ref?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  tz?: string;
  props?: Record<string, unknown>;
};

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp\/|curl|wget|python|axios|node-fetch/i;

export const isBot = (ua: string) => !ua || BOT_RE.test(ua);

export function deviceOf(ua: string): "mobile" | "tablet" | "desktop" {
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return "mobile";
  return "desktop";
}

const SOURCE_ALIASES: [RegExp, string][] = [
  [/^(ig|insta|instagram)/, "Instagram"],
  [/^(fb|facebook|meta)/, "Facebook"],
  [/^(wa|whatsapp)/, "WhatsApp"],
  [/^(yt|youtube)/, "YouTube"],
  [/^google/, "Google"],
  [/^(tw|twitter|x)$/, "X (Twitter)"],
  [/^linkedin/, "LinkedIn"],
  [/^(email|newsletter|mail)/, "Email"],
  [/^sms/, "SMS"],
];

const REFERRER_SOURCES: [RegExp, string][] = [
  [/(^|\.)google\./, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)yahoo\./, "Yahoo"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "WhatsApp"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "X (Twitter)"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "LinkedIn"],
  [/(^|\.)(chatgpt\.com|openai\.com)$/, "ChatGPT"],
  [/(^|\.)perplexity\.ai$/, "Perplexity"],
  [/(^|\.)pinterest\./, "Pinterest"],
];

/** Classifies where a session came from: utm_source wins, then the referrer, else "Direct". */
export function classifySource(ref?: string, utm?: IncomingEvent["utm"]): string {
  const us = utm?.source?.trim().toLowerCase();
  if (us) {
    const alias = SOURCE_ALIASES.find(([re]) => re.test(us))?.[1];
    const name = alias ?? us.charAt(0).toUpperCase() + us.slice(1);
    const paid = /cpc|ppc|paid|ads?$/i.test(utm?.medium ?? "");
    return (paid ? `${name} Ads` : name).slice(0, 80);
  }
  const host = ref?.trim().toLowerCase().replace(/^www\./, "");
  if (!host) return "Direct";
  return REFERRER_SOURCES.find(([re]) => re.test(host))?.[1] ?? host.slice(0, 80);
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code?: string | null) => {
  const c = code?.trim().toUpperCase();
  if (!c || !/^[A-Z]{2}$/.test(c) || c === "XX") return null;
  try {
    return regionNames.of(c) ?? c;
  } catch {
    return c;
  }
};

// Browser time zone → country, used when the hosting layer doesn't pass geo headers.
const TZ_COUNTRY: Record<string, string> = {
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Dubai": "AE", "Asia/Muscat": "OM", "Asia/Qatar": "QA",
  "Asia/Riyadh": "SA", "Asia/Kuwait": "KW", "Asia/Bahrain": "BH", "Asia/Singapore": "SG", "Asia/Kathmandu": "NP",
  "Asia/Katmandu": "NP", "Asia/Dhaka": "BD", "Asia/Colombo": "LK", "Asia/Karachi": "PK", "Asia/Bangkok": "TH",
  "Asia/Kuala_Lumpur": "MY", "Asia/Tokyo": "JP", "Asia/Hong_Kong": "HK", "Asia/Shanghai": "CN", "Asia/Jakarta": "ID",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Amsterdam": "NL",
  "Europe/Madrid": "ES", "Europe/Rome": "IT", "Europe/Zurich": "CH", "Europe/Stockholm": "SE", "Europe/Moscow": "RU",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
  "America/Phoenix": "US", "America/Toronto": "CA", "America/Vancouver": "CA", "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU", "Australia/Perth": "AU", "Pacific/Auckland": "NZ", "Africa/Johannesburg": "ZA",
  "Africa/Nairobi": "KE", "Africa/Lagos": "NG",
};

const decodeHeader = (v: string | null) => {
  if (!v) return null;
  try {
    return decodeURIComponent(v).trim().slice(0, 80) || null;
  } catch {
    return v.trim().slice(0, 80) || null;
  }
};

/**
 * Visitor location from CDN geo headers (CloudFront / Amplify, Cloudflare, Vercel), forwarded to us
 * through the Next.js /api rewrite. Falls back to the browser time zone for the country.
 */
export function geoOf(h: Headers, tz?: string) {
  const code =
    h.get("cloudfront-viewer-country") ?? h.get("cf-ipcountry") ?? h.get("x-vercel-ip-country") ?? (tz ? TZ_COUNTRY[tz] : undefined);
  return {
    country: countryName(code),
    region: decodeHeader(h.get("cloudfront-viewer-country-region-name") ?? h.get("cf-region") ?? h.get("x-vercel-ip-country-region")),
    city: decodeHeader(h.get("cloudfront-viewer-city") ?? h.get("cf-ipcity") ?? h.get("x-vercel-ip-city")),
  };
}

const cleanPath = (p?: unknown) => {
  if (typeof p !== "string" || !p.startsWith("/")) return null;
  const path = p.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return path.slice(0, 300);
};

export async function recordEvent(body: IncomingEvent, headers: Headers, userId: string | null) {
  const ua = headers.get("user-agent") ?? "";
  if (isBot(ua)) return;
  const geo = geoOf(headers, body.tz);
  const props = { ...(body.props ?? {}) };
  delete props.path;
  if (body.utm?.campaign) props.utmCampaign = body.utm.campaign.slice(0, 120);
  if (body.utm?.medium) props.utmMedium = body.utm.medium.slice(0, 60);
  await db.insert(analyticsEvents).values({
    name: body.name,
    sessionId: body.sessionId ?? null,
    visitorId: body.visitorId ?? null,
    userId,
    path: cleanPath(body.path ?? body.props?.path),
    source: classifySource(body.ref, body.utm),
    device: deviceOf(ua),
    ...geo,
    props: Object.keys(props).length ? props : null,
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────

const num = (v: unknown) => Number(v ?? 0);
const VID = sql`coalesce(${analyticsEvents.visitorId}, ${analyticsEvents.sessionId})`;
const SID = sql`coalesce(${analyticsEvents.sessionId}, ${analyticsEvents.visitorId})`;
const visitors = (where?: SQL) =>
  where ? sql<number>`count(distinct ${VID}) filter (where ${where})::int` : sql<number>`count(distinct ${VID})::int`;
const isEvent = (...names: string[]) => inArray(analyticsEvents.name, names);
const prop = (key: string) => sql<string>`${analyticsEvents.props}->>${key}`;
const PAGE_VIEW = isEvent("page_view");
const PAID = isEvent("payment_completed");

/**
 * Booking funnel: unique visitors who did each step at least once in the range. Searching is not a
 * step — many guests land straight on a property page from Google / Instagram / WhatsApp.
 */
const FUNNEL: { key: string; label: string; where: SQL }[] = [
  { key: "visited", label: "Visited the site", where: sql`true` },
  { key: "viewed", label: "Viewed a property", where: isEvent("property_viewed") },
  { key: "room", label: "Selected a room", where: isEvent("room_selected") },
  { key: "checkout", label: "Reached checkout", where: sql`(${isEvent("booking_started")} or (${PAGE_VIEW} and ${analyticsEvents.path} = '/checkout'))` },
  { key: "payment", label: "Started payment", where: isEvent("payment_started") },
  { key: "paid", label: "Completed booking", where: PAID },
];

const PAGE_LABELS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^\/$/, () => "Home"],
  [/^\/search$/, () => "Search results"],
  [/^\/checkout$/, () => "Checkout"],
  [/^\/checkout\/confirmation\/.+/, () => "Booking confirmation"],
  [/^\/(hotels|villas|farmhouses|homestays|heritage-stays)$/, (m) => `${m[1].replace("-", " ").replace(/^./, (c) => c.toUpperCase())} listing`],
  [/^\/cities\/(.+)$/, (m) => `City: ${m[1].replace(/-/g, " ")}`],
  [/^\/experiences\/(.+)$/, (m) => `Experience: ${m[1].replace(/-/g, " ")}`],
  [/^\/collections\/(.+)$/, (m) => `Collection: ${m[1].replace(/-/g, " ")}`],
  [/^\/account(\/.*)?$/, () => "My account"],
  [/^\/(login|signup)$/, (m) => (m[1] === "login" ? "Login" : "Sign up")],
];

export type AnalyticsParams = { from?: string; to?: string };

export async function siteAnalytics(params: AnalyticsParams) {
  const today = todayIST();
  const to = params.to ?? today;
  const from = params.from ?? addDays(to, -29); // default: last 30 days
  // IST day boundaries as instants, so the created_at index is used
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(`${addDays(to, 1)}T00:00:00+05:30`);
  const inRange = and(gte(analyticsEvents.createdAt, start), lt(analyticsEvents.createdAt, end));
  const day = sql<string>`to_char(${analyticsEvents.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
  const E = analyticsEvents;

  const [
    [summary],
    [newRow],
    daily,
    [funnelRow],
    pages,
    sources,
    countries,
    cities,
    devices,
    searches,
    propertyRows,
    jsErrors,
    notFound,
    paymentFailures,
    bookingErrors,
  ] = await Promise.all([
    db
      .select({
        visitors: visitors(),
        sessions: sql<number>`count(distinct ${SID})::int`,
        pageViews: sql<number>`count(*) filter (where ${PAGE_VIEW})::int`,
        bookers: visitors(PAID),
        searchers: visitors(isEvent("search_performed", "destination_selected")),
        bookings: sql<number>`count(distinct ${prop("bookingCode")}) filter (where ${PAID})::int`,
        revenue: sql<number>`coalesce(sum((${prop("amount")})::bigint) filter (where ${PAID}), 0)::bigint`,
        loggedIn: visitors(sql`${E.userId} is not null`),
      })
      .from(E)
      .where(inRange),
    // New vs returning: a visitor is "new" when their first-ever event falls inside the range
    db.execute<{ new: number; total: number }>(sql`
      select count(*) filter (where first_seen >= ${start.toISOString()}::timestamptz)::int as new, count(*)::int as total
      from (
        select ${VID} as v, min(${E.createdAt}) as first_seen from ${E}
        where ${VID} in (select distinct ${VID} from ${E} where ${inRange})
        group by 1
      ) t`),
    db
      .select({ date: day, visitors: visitors(), pageViews: sql<number>`count(*) filter (where ${PAGE_VIEW})::int` })
      .from(E)
      .where(inRange)
      .groupBy(day)
      .orderBy(day),
    db
      .select(Object.fromEntries(FUNNEL.map((s) => [s.key, visitors(s.where)])) as Record<string, SQL<number>>)
      .from(E)
      .where(inRange),
    db
      .select({ path: E.path, views: sql<number>`count(*)::int`, visitors: visitors() })
      .from(E)
      .where(and(inRange, PAGE_VIEW, sql`${E.path} is not null`))
      .groupBy(E.path)
      .orderBy(sql`count(*) desc`)
      .limit(20),
    db
      .select({
        source: sql<string>`coalesce(${E.source}, 'Direct')`,
        visitors: visitors(),
        sessions: sql<number>`count(distinct ${SID})::int`,
        bookings: sql<number>`count(distinct ${prop("bookingCode")}) filter (where ${PAID})::int`,
      })
      .from(E)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`3 desc`)
      .limit(20),
    db
      .select({ name: sql<string>`coalesce(${E.country}, 'Unknown')`, visitors: visitors() })
      .from(E)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(15),
    db
      .select({ city: E.city, region: E.region, country: E.country, visitors: visitors() })
      .from(E)
      .where(and(inRange, sql`${E.city} is not null`))
      .groupBy(E.city, E.region, E.country)
      .orderBy(sql`4 desc`)
      .limit(15),
    db
      .select({ device: sql<string>`coalesce(${E.device}, 'unknown')`, visitors: visitors() })
      .from(E)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`),
    db
      .select({ term: sql<string>`lower(coalesce(nullif(${prop("city")}, ''), nullif(${prop("q")}, '')))`, searches: sql<number>`count(*)::int`, visitors: visitors() })
      .from(E)
      .where(and(inRange, isEvent("search_performed", "destination_selected"), sql`coalesce(nullif(${prop("city")}, ''), nullif(${prop("q")}, '')) is not null`))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(15),
    db
      .select({
        propertyId: prop("propertyId"),
        views: sql<number>`count(*) filter (where ${isEvent("property_viewed")})::int`,
        visitors: visitors(isEvent("property_viewed")),
        checkouts: visitors(isEvent("booking_started")),
        bookings: sql<number>`count(distinct ${prop("bookingCode")}) filter (where ${PAID})::int`,
      })
      .from(E)
      .where(and(inRange, isEvent("property_viewed", "booking_started", "payment_completed"), sql`${prop("propertyId")} is not null`))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(20),
    db
      .select({
        message: sql<string>`left(coalesce(${prop("message")}, 'Unknown error'), 200)`,
        count: sql<number>`count(*)::int`,
        visitors: visitors(),
        lastPath: sql<string>`(array_agg(${E.path} order by ${E.createdAt} desc))[1]`,
        lastSeen: sql<string>`max(${E.createdAt})`,
      })
      .from(E)
      .where(and(inRange, isEvent("js_error")))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(15),
    db
      .select({ path: E.path, count: sql<number>`count(*)::int`, visitors: visitors() })
      .from(E)
      .where(and(inRange, isEvent("page_not_found")))
      .groupBy(E.path)
      .orderBy(sql`2 desc`)
      .limit(15),
    db
      .select({ reason: sql<string>`coalesce(${prop("reason")}, 'failed')`, count: sql<number>`count(*)::int`, visitors: visitors() })
      .from(E)
      .where(and(inRange, isEvent("payment_failed")))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`),
    db
      .select({ message: sql<string>`left(coalesce(${prop("message")}, 'Unknown'), 200)`, count: sql<number>`count(*)::int`, visitors: visitors() })
      .from(E)
      .where(and(inRange, isEvent("booking_error")))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(10),
  ]);

  // Resolve property names for /stays/<slug> pages and property ids
  const slugs = [...new Set(pages.map((p) => p.path?.match(/^\/stays\/([^/]+)$/)?.[1]).filter((s): s is string => !!s))];
  const ids = propertyRows.map((r) => r.propertyId).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const [bySlug, byId] = await Promise.all([
    slugs.length
      ? db.select({ slug: properties.slug, name: properties.name }).from(properties).where(inArray(properties.slug, slugs))
      : Promise.resolve([]),
    ids.length
      ? db.select({ id: properties.id, name: properties.name, slug: properties.slug }).from(properties).where(inArray(properties.id, ids))
      : Promise.resolve([]),
  ]);
  const slugName = new Map(bySlug.map((p) => [p.slug, p.name]));
  const idInfo = new Map(byId.map((p) => [p.id, p]));

  const pageLabel = (path: string) => {
    const stay = path.match(/^\/stays\/([^/]+)$/);
    if (stay) return `Stay: ${slugName.get(stay[1]) ?? stay[1]}`;
    for (const [re, fn] of PAGE_LABELS) {
      const m = path.match(re);
      if (m) return fn(m);
    }
    return path;
  };

  // Daily series with empty days filled in
  const dailyMap = new Map(daily.map((d) => [d.date, d]));
  const series: { date: string; visitors: number; pageViews: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = dailyMap.get(d);
    series.push({ date: d, visitors: num(r?.visitors), pageViews: num(r?.pageViews) });
    if (series.length > 400) break;
  }

  const totalVisitors = num(summary?.visitors);
  const sessions = num(summary?.sessions);
  const pageViews = num(summary?.pageViews);
  const newVisitors = num(newRow?.new);
  const funnel = FUNNEL.map((s, i) => {
    const count = num(funnelRow?.[s.key]);
    const prev = i === 0 ? count : num(funnelRow?.[FUNNEL[i - 1].key]);
    return {
      key: s.key,
      label: s.label,
      visitors: count,
      ofVisited: totalVisitors ? count / totalVisitors : 0,
      fromPrevious: prev ? Math.min(1, count / prev) : 0,
    };
  });
  const reachedCheckout = funnel.find((f) => f.key === "checkout")!.visitors;
  const completed = funnel.find((f) => f.key === "paid")!.visitors;

  return {
    range: { from, to },
    summary: {
      visitors: totalVisitors,
      newVisitors,
      returningVisitors: Math.max(0, totalVisitors - newVisitors),
      sessions,
      pageViews,
      pagesPerSession: sessions ? pageViews / sessions : 0,
      loggedInVisitors: num(summary?.loggedIn),
      searchers: num(summary?.searchers),
      bookings: num(summary?.bookings),
      bookingRevenue: num(summary?.revenue),
      conversionRate: totalVisitors ? num(summary?.bookers) / totalVisitors : 0,
    },
    daily: series,
    funnel,
    topPages: pages.map((p) => ({ path: p.path!, label: pageLabel(p.path!), views: num(p.views), visitors: num(p.visitors) })),
    sources: sources.map((s) => ({ source: s.source, visitors: num(s.visitors), sessions: num(s.sessions), bookings: num(s.bookings) })),
    countries: countries.map((c) => ({ country: c.name, visitors: num(c.visitors) })),
    cities: cities.map((c) => ({ city: c.city!, region: c.region, country: c.country, visitors: num(c.visitors) })),
    devices: devices.map((d) => ({ device: d.device, visitors: num(d.visitors) })),
    searches: searches.map((s) => ({ term: s.term, searches: num(s.searches), visitors: num(s.visitors) })),
    properties: propertyRows
      .map((r) => ({
        propertyId: r.propertyId,
        name: idInfo.get(r.propertyId)?.name ?? "Unknown property",
        slug: idInfo.get(r.propertyId)?.slug ?? null,
        views: num(r.views),
        visitors: num(r.visitors),
        checkouts: num(r.checkouts),
        bookings: num(r.bookings),
      }))
      .filter((r) => r.views > 0 || r.bookings > 0),
    issues: {
      abandonedCheckouts: Math.max(0, reachedCheckout - completed),
      jsErrors: jsErrors.map((e) => ({ message: e.message, count: num(e.count), visitors: num(e.visitors), lastPath: e.lastPath, lastSeen: e.lastSeen })),
      notFound: notFound.map((n) => ({ path: n.path ?? "—", count: num(n.count), visitors: num(n.visitors) })),
      paymentFailures: paymentFailures.map((p) => ({ reason: p.reason, count: num(p.count), visitors: num(p.visitors) })),
      bookingErrors: bookingErrors.map((b) => ({ message: b.message, count: num(b.count), visitors: num(b.visitors) })),
    },
  };
}
