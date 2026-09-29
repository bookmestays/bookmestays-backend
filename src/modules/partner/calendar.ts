// Partner: inventory + rates calendar (GET) and bulk updates (PUT) with daysOfWeek filtering.
// Missing inventory rows = total roomType.totalRooms; missing rates rows = ratePlan.basePrice, minStay 1.
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { inventory, ratePlans, rates, roomTypes } from "../../db/schema";
import { audit } from "../../lib/audit";
import { authPlugin } from "../../lib/auth";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors";
import { addDays, diffDays, parseDate, todayIST } from "../../lib/utils";
import { dateStr, money } from "../admin/schemas";
import { ownProperty } from "./scope";

const idParams = t.Object({ id: t.String() });
const MAX_VIEW_DAYS = 62;
const MAX_BULK_DAYS = 366;

function datesInRange(from: string, to: string, daysOfWeek?: number[]) {
  if (to < from) throw badRequest("'to' must be on or after 'from'");
  if (diffDays(from, to) + 1 > MAX_BULK_DAYS) throw badRequest(`You can update at most ${MAX_BULK_DAYS} days at once`);
  const dow = daysOfWeek?.length ? new Set(daysOfWeek) : null;
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!dow || dow.has(parseDate(d).getUTCDay())) out.push(d);
  if (!out.length) throw badRequest("No dates match the selected days of the week");
  return out;
}

const channelManagedError = () =>
  new AppError(
    409,
    "CHANNEL_MANAGED",
    "Rates and availability for this property are managed by your channel manager. Update them there.",
  );

export const partnerCalendar = new Elysia({ name: "partner-calendar" })
  .use(authPlugin)

  .get(
    "/properties/:id/calendar",
    async ({ partnerId, params, query }) => {
      const p = await ownProperty(partnerId, params.id);
      const from = query.from ?? todayIST();
      const to = query.to ?? addDays(from, 29);
      if (to < from) throw badRequest("'to' must be on or after 'from'");
      if (diffDays(from, to) + 1 > MAX_VIEW_DAYS) throw badRequest(`The calendar shows at most ${MAX_VIEW_DAYS} days`);
      const days: string[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

      const rts = await db
        .select()
        .from(roomTypes)
        .where(and(eq(roomTypes.propertyId, p.id), ne(roomTypes.status, "INACTIVE")))
        .orderBy(asc(roomTypes.sort), asc(roomTypes.createdAt));
      const rtIds = rts.map((r) => r.id);
      const plans = rtIds.length
        ? await db
            .select()
            .from(ratePlans)
            .where(inArray(ratePlans.roomTypeId, rtIds))
            .orderBy(asc(ratePlans.sort), asc(ratePlans.createdAt))
        : [];
      const planIds = plans.map((r) => r.id);
      const [invRows, rateRows] = await Promise.all([
        rtIds.length
          ? db
              .select()
              .from(inventory)
              .where(and(inArray(inventory.roomTypeId, rtIds), gte(inventory.date, from), lte(inventory.date, to)))
          : [],
        planIds.length
          ? db
              .select()
              .from(rates)
              .where(and(inArray(rates.ratePlanId, planIds), gte(rates.date, from), lte(rates.date, to)))
          : [],
      ]);
      const invMap = new Map(invRows.map((r) => [`${r.roomTypeId}|${r.date}`, r]));
      const rateMap = new Map(rateRows.map((r) => [`${r.ratePlanId}|${r.date}`, r]));

      return {
        from,
        to,
        channelManaged: p.channelManaged,
        roomTypes: rts.map((rt) => ({
          id: rt.id,
          name: rt.name,
          totalRooms: rt.totalRooms,
          days: days.map((date) => {
            const inv = invMap.get(`${rt.id}|${date}`);
            const total = inv?.total ?? rt.totalRooms;
            const sold = inv?.sold ?? 0;
            const held = inv?.held ?? 0;
            const blocked = inv?.blocked ?? 0;
            return {
              date,
              total,
              sold,
              held,
              blocked,
              available: Math.max(0, total - sold - held - blocked),
              stopSell: inv?.stopSell ?? false,
            };
          }),
          ratePlans: plans
            .filter((plan) => plan.roomTypeId === rt.id)
            .map((plan) => ({
              id: plan.id,
              name: plan.name,
              days: days.map((date) => {
                const r = rateMap.get(`${plan.id}|${date}`);
                return {
                  date,
                  price: r?.price ?? plan.basePrice,
                  minStay: r?.minStay ?? 1,
                  maxStay: r?.maxStay ?? null,
                  closedToArrival: r?.closedToArrival ?? false,
                  closedToDeparture: r?.closedToDeparture ?? false,
                  stopSell: r?.stopSell ?? false,
                };
              }),
            })),
        })),
      };
    },
    { partner: true, params: idParams, query: t.Object({ from: t.Optional(dateStr), to: t.Optional(dateStr) }) },
  )

  .put(
    "/properties/:id/calendar/inventory",
    async ({ authUser, partnerId, params, body }) => {
      const p = await ownProperty(partnerId, params.id);
      if (p.channelManaged) throw channelManagedError();
      const rt = await db.query.roomTypes.findFirst({
        where: and(eq(roomTypes.id, body.roomTypeId), eq(roomTypes.propertyId, p.id)),
      });
      if (!rt) throw notFound("Room type");
      if (body.total === undefined && body.blocked === undefined && body.stopSell === undefined)
        throw badRequest("Nothing to update — set total, blocked or stopSell");
      const dates = datesInRange(body.from, body.to, body.daysOfWeek);

      await db.transaction(async (tx) => {
        // Lock existing rows so concurrent bookings cannot oversell while we validate.
        const existing = await tx
          .select()
          .from(inventory)
          .where(and(eq(inventory.roomTypeId, rt.id), inArray(inventory.date, dates)))
          .for("update");
        const byDate = new Map(existing.map((r) => [r.date, r]));
        const invalid: { date: string; committed: number }[] = [];
        for (const date of dates) {
          const cur = byDate.get(date);
          const total = body.total ?? cur?.total ?? rt.totalRooms;
          const blocked = body.blocked ?? cur?.blocked ?? 0;
          const committed = (cur?.sold ?? 0) + (cur?.held ?? 0);
          if (committed + blocked > total) invalid.push({ date, committed });
        }
        if (invalid.length)
          throw conflict(
            `Booked + blocked rooms would exceed the total rooms on ${invalid.length} date(s) (e.g. ${invalid[0].date})`,
            invalid.slice(0, 31),
          );
        const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: "PARTNER" };
        if (body.total !== undefined) set.total = sql`excluded.total`;
        if (body.blocked !== undefined) set.blocked = sql`excluded.blocked`;
        if (body.stopSell !== undefined) set.stopSell = sql`excluded.stop_sell`;
        await tx
          .insert(inventory)
          .values(
            dates.map((date) => ({
              roomTypeId: rt.id,
              date,
              total: body.total ?? rt.totalRooms,
              blocked: body.blocked ?? 0,
              stopSell: body.stopSell ?? false,
              updatedBy: "PARTNER",
            })),
          )
          .onConflictDoUpdate({ target: [inventory.roomTypeId, inventory.date], set });
      });
      await audit(authUser, "calendar.inventory", "room_type", rt.id, { ...body, days: dates.length });
      return { ok: true, days: dates.length };
    },
    {
      partner: "inventory",
      params: idParams,
      body: t.Object({
        roomTypeId: t.String({ format: "uuid" }),
        from: dateStr,
        to: dateStr,
        daysOfWeek: t.Optional(t.Array(t.Integer({ minimum: 0, maximum: 6 }), { maxItems: 7 })),
        total: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
        blocked: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
        stopSell: t.Optional(t.Boolean()),
      }),
    },
  )

  .put(
    "/properties/:id/calendar/rates",
    async ({ authUser, partnerId, params, body }) => {
      const p = await ownProperty(partnerId, params.id);
      if (p.channelManaged) throw channelManagedError();
      const [row] = await db
        .select({ plan: ratePlans })
        .from(ratePlans)
        .innerJoin(roomTypes, eq(roomTypes.id, ratePlans.roomTypeId))
        .where(and(eq(ratePlans.id, body.ratePlanId), eq(roomTypes.propertyId, p.id)));
      if (!row) throw notFound("Rate plan");
      const { plan } = row;
      const fields = ["price", "minStay", "maxStay", "closedToArrival", "closedToDeparture", "stopSell"] as const;
      if (!fields.some((f) => body[f] !== undefined)) throw badRequest("Nothing to update");
      if (body.minStay != null && body.maxStay != null && body.maxStay < body.minStay)
        throw badRequest("Maximum stay cannot be less than minimum stay");
      const dates = datesInRange(body.from, body.to, body.daysOfWeek);

      const columnOf = {
        price: "price",
        minStay: "min_stay",
        maxStay: "max_stay",
        closedToArrival: "closed_to_arrival",
        closedToDeparture: "closed_to_departure",
        stopSell: "stop_sell",
      } as const;
      const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: "PARTNER" };
      for (const f of fields) if (body[f] !== undefined) set[f] = sql.raw(`excluded.${columnOf[f]}`);

      await db
        .insert(rates)
        .values(
          dates.map((date) => ({
            ratePlanId: plan.id,
            date,
            price: body.price ?? plan.basePrice,
            minStay: body.minStay ?? 1,
            maxStay: body.maxStay ?? null,
            closedToArrival: body.closedToArrival ?? false,
            closedToDeparture: body.closedToDeparture ?? false,
            stopSell: body.stopSell ?? false,
            updatedBy: "PARTNER",
          })),
        )
        .onConflictDoUpdate({ target: [rates.ratePlanId, rates.date], set });
      await audit(authUser, "calendar.rates", "rate_plan", plan.id, { ...body, days: dates.length });
      return { ok: true, days: dates.length };
    },
    {
      partner: "inventory",
      params: idParams,
      body: t.Object({
        ratePlanId: t.String({ format: "uuid" }),
        from: dateStr,
        to: dateStr,
        daysOfWeek: t.Optional(t.Array(t.Integer({ minimum: 0, maximum: 6 }), { maxItems: 7 })),
        price: t.Optional(money),
        minStay: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
        maxStay: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 365 }))),
        closedToArrival: t.Optional(t.Boolean()),
        closedToDeparture: t.Optional(t.Boolean()),
        stopSell: t.Optional(t.Boolean()),
      }),
    },
  );
