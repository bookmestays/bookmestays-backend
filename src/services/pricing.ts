// Pricing / availability engine shared by the availability endpoint, quotes and booking creation.
//
// Rules (API_CONTRACT §8):
//  • nightly price = rates.price for that date, else ratePlan.basePrice; + extra adult / child charges above
//    the base occupancy of 2 adults per room.
//  • availability = total − sold − held − blocked; a missing inventory row means total = roomType.totalRooms.
//  • restrictions: stop-sell (inventory or rate), min/max stay + closed-to-arrival on the check-in date,
//    closed-to-departure on the check-out date.
//  • room GST: per room per night, slab from site_settings.tax.roomGstSlabs on that night's price.
//  • commission: room type rule → property rule → partner-wide rule → partner default.
//  • payout = room + room GST − commission − GST on commission − TCS − TDS − partner-funded discount.
import { and, desc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import {
  bookings,
  commissionRules,
  coupons,
  inventory,
  partners,
  properties,
  ratePlans,
  rates,
  roomTypes,
  type CancellationPolicy,
} from "../db/schema";
import { AppError, notFound, unprocessable } from "../lib/errors";
import { applyBps, diffDays, nightsBetween, todayIST } from "../lib/utils";
import { getBookingSettings, getTaxSettings, type TaxSettings } from "./settings";

export type Exec = typeof db | Tx;
export type PropertyRow = typeof properties.$inferSelect;
export type PartnerRow = typeof partners.$inferSelect;
export type RoomTypeRow = typeof roomTypes.$inferSelect;
export type RatePlanRow = typeof ratePlans.$inferSelect;
export type CouponRow = typeof coupons.$inferSelect;

export const BASE_OCCUPANCY = 2;
export const NON_REFUNDABLE: CancellationPolicy = {
  summary: "Non-refundable — no refund if you cancel.",
  rules: [],
};

export const notAvailable = (message: string, details?: unknown) =>
  new AppError(409, "NOT_AVAILABLE", message, details);

// ─── Context loading ─────────────────────────────────────────────────────────

export type InvDay = { total: number; sold: number; held: number; blocked: number; stopSell: boolean };
export type RateDay = {
  price: number;
  minStay: number;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
};

export type PricingContext = {
  property: PropertyRow;
  partner: PartnerRow;
  roomTypes: RoomTypeRow[];
  ratePlans: RatePlanRow[];
  checkIn: string;
  checkOut: string;
  nights: string[];
  inventory: Map<string, Map<string, InvDay>>; // roomTypeId → date → row
  rates: Map<string, Map<string, RateDay>>; // ratePlanId → date → row (incl. check-out date for CTD)
  tax: TaxSettings;
};

export async function loadPricingContext(
  exec: Exec,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  opts: { roomTypeIds?: string[]; publicOnly?: boolean } = {},
): Promise<PricingContext> {
  const rtWhere = [eq(roomTypes.propertyId, propertyId)];
  if (opts.publicOnly) rtWhere.push(eq(roomTypes.status, "ACTIVE"));
  if (opts.roomTypeIds?.length) rtWhere.push(inArray(roomTypes.id, opts.roomTypeIds));
  // Independent reads run in parallel (fewer round-trips to the database)
  const [[property], rts, tax] = await Promise.all([
    exec.select().from(properties).where(eq(properties.id, propertyId)),
    exec.select().from(roomTypes).where(and(...rtWhere)).orderBy(roomTypes.sort, roomTypes.createdAt),
    getTaxSettings(),
  ]);
  if (!property) throw notFound("Property");
  const rtIds = rts.map((r) => r.id);

  const [[partner], rps, invRows] = await Promise.all([
    exec.select().from(partners).where(eq(partners.id, property.partnerId)),
    rtIds.length
      ? exec
          .select()
          .from(ratePlans)
          .where(and(inArray(ratePlans.roomTypeId, rtIds), opts.publicOnly ? eq(ratePlans.isActive, true) : undefined))
          .orderBy(ratePlans.sort, ratePlans.createdAt)
      : Promise.resolve([] as RatePlanRow[]),
    rtIds.length
      ? exec
          .select()
          .from(inventory)
          .where(and(inArray(inventory.roomTypeId, rtIds), gte(inventory.date, checkIn), lt(inventory.date, checkOut)))
      : Promise.resolve([] as (typeof inventory.$inferSelect)[]),
  ]);
  const rpIds = rps.map((r) => r.id);
  const rateRows = rpIds.length
    ? await exec
        .select()
        .from(rates)
        .where(and(inArray(rates.ratePlanId, rpIds), gte(rates.date, checkIn), lte(rates.date, checkOut)))
    : [];

  const inv = new Map<string, Map<string, InvDay>>();
  for (const r of invRows) {
    if (!inv.has(r.roomTypeId)) inv.set(r.roomTypeId, new Map());
    inv.get(r.roomTypeId)!.set(r.date, r);
  }
  const rateMap = new Map<string, Map<string, RateDay>>();
  for (const r of rateRows) {
    if (!rateMap.has(r.ratePlanId)) rateMap.set(r.ratePlanId, new Map());
    rateMap.get(r.ratePlanId)!.set(r.date, r);
  }

  return {
    property,
    partner,
    roomTypes: rts,
    ratePlans: rps,
    checkIn,
    checkOut,
    nights: nightsBetween(checkIn, checkOut),
    inventory: inv,
    rates: rateMap,
    tax,
  };
}

// ─── Inventory & restrictions ────────────────────────────────────────────────

export function inventoryDay(ctx: PricingContext, rt: RoomTypeRow, date: string): InvDay {
  return (
    ctx.inventory.get(rt.id)?.get(date) ?? { total: rt.totalRooms, sold: 0, held: 0, blocked: 0, stopSell: false }
  );
}

export const availableOf = (d: InvDay) => (d.stopSell ? 0 : Math.max(0, d.total - d.sold - d.held - d.blocked));

/** Rooms of this type bookable on every night of the stay. */
export function availableRooms(ctx: PricingContext, rt: RoomTypeRow): number {
  if (!ctx.nights.length) return 0;
  return Math.min(...ctx.nights.map((d) => availableOf(inventoryDay(ctx, rt, d))));
}

export function rateDay(ctx: PricingContext, rp: RatePlanRow, date: string): RateDay {
  return (
    ctx.rates.get(rp.id)?.get(date) ?? {
      price: rp.basePrice,
      minStay: 1,
      maxStay: null,
      closedToArrival: false,
      closedToDeparture: false,
      stopSell: false,
    }
  );
}

/** Human readable reason why this rate plan can't be booked for the stay, or null. */
export function restrictionReason(ctx: PricingContext, rp: RatePlanRow): string | null {
  const n = ctx.nights.length;
  for (const d of ctx.nights) if (rateDay(ctx, rp, d).stopSell) return "Not available for the selected dates";
  const arrival = rateDay(ctx, rp, ctx.checkIn);
  if (arrival.minStay > n) return `Minimum stay ${arrival.minStay} nights`;
  if (arrival.maxStay && n > arrival.maxStay) return `Maximum stay ${arrival.maxStay} nights`;
  if (arrival.closedToArrival) return "Check-in not available on this date";
  if (rateDay(ctx, rp, ctx.checkOut).closedToDeparture) return "Check-out not available on this date";
  return null;
}

// ─── Occupancy & prices ──────────────────────────────────────────────────────

export type Occupancy = { adults: number; children: number };
type RoomCap = Pick<RoomTypeRow, "maxAdults" | "maxChildren" | "maxOccupancy">;

/**
 * Spread guests across the booked rooms (round-robin, respecting each room's capacity).
 * Every room gets at least one adult. Returns an error message when the guests don't fit.
 */
export function allocateGuests(rooms: RoomCap[], adults: number, children: number): Occupancy[] | string {
  if (!rooms.length) return "Select at least one room";
  if (adults < rooms.length) return "Each room needs at least one adult";
  const occ = rooms.map(() => ({ adults: 1, children: 0 }));
  const place = (count: number, kind: "adults" | "children") => {
    let i = 0;
    for (let placed = 0; placed < count; ) {
      let tried = 0;
      while (tried < rooms.length) {
        const r = rooms[i % rooms.length];
        const o = occ[i % rooms.length];
        i++;
        tried++;
        const cap = kind === "adults" ? r.maxAdults : r.maxChildren;
        if (o[kind] < cap && o.adults + o.children < r.maxOccupancy) {
          o[kind]++;
          placed++;
          break;
        }
        if (tried === rooms.length) return false;
      }
    }
    return true;
  };
  if (rooms.some((r) => r.maxAdults < 1 || r.maxOccupancy < 1)) return "Selected room cannot host guests";
  if (!place(adults - rooms.length, "adults")) return "Too many adults for the selected rooms";
  if (!place(children, "children")) return "Too many children for the selected rooms";
  return occ;
}

/** Price of one room for one night at the given occupancy (extra guests above 2 base adults). */
export function roomNightPrice(ctx: PricingContext, rp: RatePlanRow, date: string, o: Occupancy): number {
  const extraAdults = Math.max(0, o.adults - BASE_OCCUPANCY);
  const freeChildSlots = Math.max(0, BASE_OCCUPANCY - o.adults);
  const extraChildren = Math.max(0, o.children - freeChildSlots);
  return rateDay(ctx, rp, date).price + extraAdults * rp.extraAdultPrice + extraChildren * rp.extraChildPrice;
}

export function gstBpsFor(tax: TaxSettings, pricePerNight: number): number {
  const slabs = [...tax.roomGstSlabs].sort(
    (a, b) => (a.upToPerNight ?? Number.MAX_SAFE_INTEGER) - (b.upToPerNight ?? Number.MAX_SAFE_INTEGER),
  );
  for (const s of slabs) if (s.upToPerNight == null || pricePerNight <= s.upToPerNight) return s.rateBps;
  return slabs.at(-1)?.rateBps ?? 0;
}

export type PricedRooms = {
  nightly: { date: string; price: number }[]; // per room (average when occupancies differ)
  amount: number; // all rooms × nights, before tax
  tax: number; // room GST, all rooms × nights
};

export function priceRooms(ctx: PricingContext, rp: RatePlanRow, occs: Occupancy[]): PricedRooms {
  let amount = 0;
  let tax = 0;
  const nightly = ctx.nights.map((date) => {
    let nightTotal = 0;
    for (const o of occs) {
      const p = roomNightPrice(ctx, rp, date, o);
      nightTotal += p;
      tax += applyBps(p, gstBpsFor(ctx.tax, p));
    }
    amount += nightTotal;
    return { date, price: Math.round(nightTotal / Math.max(1, occs.length)) };
  });
  return { nightly, amount, tax };
}

// ─── Policies ────────────────────────────────────────────────────────────────

export function ratePlanPolicy(rp: RatePlanRow, property: PropertyRow, partner: PartnerRow): CancellationPolicy {
  if (!rp.isRefundable) return NON_REFUNDABLE;
  return rp.cancellationPolicy ?? property.cancellationPolicy ?? partner.defaultCancellationPolicy ?? NON_REFUNDABLE;
}

/** When several rate plans are booked together the least generous policy applies. */
export function strictestPolicy(policies: CancellationPolicy[]): CancellationPolicy {
  const generosity = (p: CancellationPolicy) =>
    [0, 12, 24, 48, 72, 168, 336, 720].reduce((sum, h) => sum + refundPercentAt(p, h), 0);
  return policies.reduce((a, b) => (generosity(b) < generosity(a) ? b : a), policies[0] ?? NON_REFUNDABLE);
}

export function refundPercentAt(policy: CancellationPolicy, hoursBefore: number): number {
  if (hoursBefore < 0) return 0;
  const rules = [...(policy.rules ?? [])].sort((a, b) => b.hoursBeforeCheckIn - a.hoursBeforeCheckIn);
  for (const r of rules) if (hoursBefore >= r.hoursBeforeCheckIn) return Math.max(0, Math.min(100, r.refundPercent));
  return 0;
}

/** Hours from `now` until check-in (check-in date at the property's check-in time, IST). */
export function hoursUntilCheckIn(checkIn: string, checkInTime: string | null, now = new Date()) {
  const time = /^\d{2}:\d{2}$/.test(checkInTime ?? "") ? checkInTime : "14:00";
  const at = new Date(`${checkIn}T${time}:00+05:30`).getTime();
  return (at - now.getTime()) / 3_600_000;
}

// ─── Commission ──────────────────────────────────────────────────────────────

export type CommissionTerm = { type: "PERCENT" | "FLAT"; value: number };

export async function resolveCommissions(
  exec: Exec,
  partner: PartnerRow,
  propertyId: string,
  roomTypeIds: string[],
  onDate = todayIST(),
): Promise<Map<string, CommissionTerm>> {
  const rules = await exec
    .select()
    .from(commissionRules)
    .where(
      and(
        eq(commissionRules.partnerId, partner.id),
        lte(commissionRules.effectiveFrom, onDate),
        or(isNull(commissionRules.effectiveTo), gte(commissionRules.effectiveTo, onDate)),
        or(eq(commissionRules.propertyId, propertyId), isNull(commissionRules.propertyId)),
      ),
    )
    .orderBy(desc(commissionRules.effectiveFrom), desc(commissionRules.createdAt));
  const out = new Map<string, CommissionTerm>();
  for (const rtId of roomTypeIds) {
    const rule =
      rules.find((r) => r.roomTypeId === rtId) ??
      rules.find((r) => r.propertyId === propertyId && !r.roomTypeId) ??
      rules.find((r) => !r.propertyId && !r.roomTypeId);
    out.set(
      rtId,
      rule
        ? { type: rule.type, value: rule.value }
        : { type: partner.defaultCommissionType, value: partner.defaultCommissionValue },
    );
  }
  return out;
}

export const commissionFor = (term: CommissionTerm, amount: number, roomNights: number) =>
  term.type === "PERCENT" ? applyBps(amount, term.value) : term.value * roomNights;

// ─── Coupons ─────────────────────────────────────────────────────────────────

export async function evaluateCoupon(
  exec: Exec,
  code: string,
  ctx: { propertyId: string; roomAmount: number; userId?: string | null },
): Promise<{ coupon: CouponRow; discount: number } | { error: string }> {
  const [coupon] = await exec
    .select()
    .from(coupons)
    .where(sql`upper(${coupons.code}) = ${code.trim().toUpperCase()}`);
  const now = new Date();
  if (!coupon || !coupon.isActive) return { error: "This coupon code is not valid" };
  if (coupon.validFrom && coupon.validFrom > now) return { error: "This coupon is not active yet" };
  if (coupon.validTo && coupon.validTo < now) return { error: "This coupon has expired" };
  if (coupon.propertyId && coupon.propertyId !== ctx.propertyId)
    return { error: "This coupon is not valid for this property" };
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit)
    return { error: "This coupon has reached its usage limit" };
  if (ctx.roomAmount < coupon.minBookingAmount)
    return { error: `Minimum booking amount of ₹${Math.ceil(coupon.minBookingAmount / 100)} required` };
  if (ctx.userId && coupon.perUserLimit > 0) {
    const [{ n }] = await exec
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(
        and(
          eq(bookings.userId, ctx.userId),
          eq(bookings.couponId, coupon.id),
          notInArray(bookings.status, ["CANCELLED", "EXPIRED"]),
        ),
      );
    if (n >= coupon.perUserLimit) return { error: "You have already used this coupon" };
  }
  let discount = coupon.type === "PERCENT" ? applyBps(ctx.roomAmount, coupon.value) : coupon.value;
  if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.max(0, Math.min(discount, ctx.roomAmount));
  return { coupon, discount };
}

// ─── Stay validation ─────────────────────────────────────────────────────────

export async function validateStay(checkIn: string, checkOut: string) {
  const settings = await getBookingSettings();
  if (checkIn < todayIST()) throw unprocessable("Check-in date cannot be in the past");
  const nights = diffDays(checkIn, checkOut);
  if (nights < 1) throw unprocessable("Check-out must be after check-in");
  if (nights > settings.maxNights) throw unprocessable(`Bookings are limited to ${settings.maxNights} nights`);
  return { nights, settings };
}

// ─── Quote ───────────────────────────────────────────────────────────────────

export type QuoteInput = {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: { roomTypeId: string; ratePlanId: string; quantity: number }[];
  couponCode?: string;
};

export type QuoteLine = {
  roomType: RoomTypeRow;
  ratePlan: RatePlanRow;
  quantity: number;
  adults: number;
  children: number;
  nightly: { date: string; price: number }[];
  amount: number;
  tax: number;
  commission: CommissionTerm;
  commissionAmount: number;
};

export type PriceQuote = {
  nights: number;
  lines: {
    roomTypeId: string;
    ratePlanId: string;
    roomTypeName: string;
    ratePlanName: string;
    quantity: number;
    nightly: { date: string; price: number }[];
    amount: number;
  }[];
  roomAmount: number;
  roomTax: number;
  addonsAmount: number;
  discountAmount: number;
  totalAmount: number;
  coupon: { code: string; discount: number } | null;
  couponError?: string;
  cancellationPolicy: CancellationPolicy;
  terms: string | null;
};

export type QuoteResult = {
  quote: PriceQuote;
  ctx: PricingContext;
  lines: QuoteLine[];
  roomAmount: number;
  roomTax: number;
  discountAmount: number;
  totalAmount: number;
  commissionAmount: number;
  commissionTax: number;
  tcsAmount: number;
  tdsAmount: number;
  partnerPayout: number;
  coupon: CouponRow | null;
  cancellationPolicy: CancellationPolicy;
  terms: string | null;
};

/**
 * Validates a booking request and prices it. Throws 404/409/422 AppErrors for unbookable requests;
 * coupon problems are reported in `quote.couponError` instead of failing.
 * Pass a transaction whose inventory rows are already locked to get a race-free availability check.
 */
export async function buildQuote(
  exec: Exec,
  input: QuoteInput,
  opts: {
    userId?: string | null;
    /** Rooms already sold to the booking being modified: roomTypeId → date → quantity (treated as free). */
    release?: Map<string, Map<string, number>>;
  } = {},
): Promise<QuoteResult> {
  const { settings } = await validateStay(input.checkIn, input.checkOut);
  if (!input.rooms.length) throw unprocessable("Select at least one room");
  const totalRooms = input.rooms.reduce((s, r) => s + r.quantity, 0);
  if (input.rooms.some((r) => r.quantity < 1)) throw unprocessable("Room quantity must be at least 1");
  if (totalRooms > settings.maxRoomsPerBooking)
    throw unprocessable(`You can book up to ${settings.maxRoomsPerBooking} rooms at a time`);

  const ctx = await loadPricingContext(exec, input.propertyId, input.checkIn, input.checkOut, {
    roomTypeIds: [...new Set(input.rooms.map((r) => r.roomTypeId))],
    publicOnly: true,
  });
  if (ctx.property.status !== "LIVE") throw notFound("Property");
  if (opts.release)
    for (const [rtId, dates] of opts.release)
      for (const [date, qty] of dates) {
        const day = ctx.inventory.get(rtId)?.get(date);
        if (day) ctx.inventory.get(rtId)!.set(date, { ...day, sold: Math.max(0, day.sold - qty) });
      }

  const resolved = input.rooms.map((r) => {
    const roomType = ctx.roomTypes.find((x) => x.id === r.roomTypeId);
    const ratePlan = ctx.ratePlans.find((x) => x.id === r.ratePlanId && x.roomTypeId === r.roomTypeId);
    if (!roomType || !ratePlan) throw unprocessable("One of the selected rooms is no longer available");
    return { ...r, roomType, ratePlan };
  });

  // Availability per room type (a room type may appear with several rate plans)
  const needed = new Map<string, number>();
  for (const r of resolved) needed.set(r.roomTypeId, (needed.get(r.roomTypeId) ?? 0) + r.quantity);
  for (const [rtId, qty] of needed) {
    const rt = ctx.roomTypes.find((x) => x.id === rtId)!;
    const available = availableRooms(ctx, rt);
    if (available < qty)
      throw notAvailable(
        available === 0
          ? `${rt.name} is sold out for the selected dates`
          : `Only ${available} room${available > 1 ? "s" : ""} of ${rt.name} left for the selected dates`,
        { roomTypeId: rtId, available },
      );
  }
  for (const r of resolved) {
    const reason = restrictionReason(ctx, r.ratePlan);
    if (reason) throw notAvailable(`${r.roomType.name} (${r.ratePlan.name}): ${reason}`, { ratePlanId: r.ratePlanId });
  }

  const caps = resolved.flatMap((r) => Array.from({ length: r.quantity }, () => r.roomType));
  const occ = allocateGuests(caps, input.adults, input.children);
  if (typeof occ === "string") throw unprocessable(occ);

  const commissions = await resolveCommissions(exec, ctx.partner, ctx.property.id, [...needed.keys()]);
  let cursor = 0;
  const lines: QuoteLine[] = resolved.map((r) => {
    const occs = occ.slice(cursor, cursor + r.quantity);
    cursor += r.quantity;
    const priced = priceRooms(ctx, r.ratePlan, occs);
    const commission = commissions.get(r.roomTypeId)!;
    return {
      roomType: r.roomType,
      ratePlan: r.ratePlan,
      quantity: r.quantity,
      adults: occs.reduce((s, o) => s + o.adults, 0),
      children: occs.reduce((s, o) => s + o.children, 0),
      nightly: priced.nightly,
      amount: priced.amount,
      tax: priced.tax,
      commission,
      commissionAmount: commissionFor(commission, priced.amount, r.quantity * ctx.nights.length),
    };
  });

  const roomAmount = lines.reduce((s, l) => s + l.amount, 0);
  const roomTax = lines.reduce((s, l) => s + l.tax, 0);

  let coupon: CouponRow | null = null;
  let discountAmount = 0;
  let couponError: string | undefined;
  if (input.couponCode?.trim()) {
    const res = await evaluateCoupon(exec, input.couponCode, {
      propertyId: ctx.property.id,
      roomAmount,
      userId: opts.userId,
    });
    if ("error" in res) couponError = res.error;
    else {
      coupon = res.coupon;
      discountAmount = res.discount;
    }
  }

  const commissionAmount = lines.reduce((s, l) => s + l.commissionAmount, 0);
  const commissionTax = applyBps(commissionAmount, ctx.tax.commissionGstBps);
  const tcsAmount = applyBps(roomAmount, ctx.tax.tcsBps);
  const tdsAmount = applyBps(roomAmount, ctx.tax.tdsBps);
  const partnerFunded = coupon?.fundedBy === "PARTNER" ? discountAmount : 0;
  const partnerPayout = roomAmount + roomTax - commissionAmount - commissionTax - tcsAmount - tdsAmount - partnerFunded;
  const totalAmount = roomAmount + roomTax - discountAmount;

  const cancellationPolicy = strictestPolicy(
    lines.map((l) => ratePlanPolicy(l.ratePlan, ctx.property, ctx.partner)),
  );
  const terms = ctx.property.terms ?? ctx.partner.defaultTerms ?? null;

  const quote: PriceQuote = {
    nights: ctx.nights.length,
    lines: lines.map((l) => ({
      roomTypeId: l.roomType.id,
      ratePlanId: l.ratePlan.id,
      roomTypeName: l.roomType.name,
      ratePlanName: l.ratePlan.name,
      quantity: l.quantity,
      nightly: l.nightly,
      amount: l.amount,
    })),
    roomAmount,
    roomTax,
    addonsAmount: 0,
    discountAmount,
    totalAmount,
    coupon: coupon ? { code: coupon.code, discount: discountAmount } : null,
    ...(couponError ? { couponError } : {}),
    cancellationPolicy,
    terms,
  };

  return {
    quote,
    ctx,
    lines,
    roomAmount,
    roomTax,
    discountAmount,
    totalAmount,
    commissionAmount,
    commissionTax,
    tcsAmount,
    tdsAmount,
    partnerPayout,
    coupon,
    cancellationPolicy,
    terms,
  };
}
