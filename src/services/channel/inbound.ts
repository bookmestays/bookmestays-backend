// Inbound channel-manager API: authenticate → parse → resolve connection/mappings → apply → respond → log.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "../../db";
import {
  bookings,
  channelConnections,
  channelMappings,
  channelSyncLogs,
  inventory,
  ratePlans,
  roomTypes,
  rates,
} from "../../db/schema";
import { addDays, diffDays, nightsBetween, parseDate, todayIST } from "../../lib/utils";
import { reservationPayload, truncate } from "./outbound";
import { adapterBySlug } from "./providers";
import {
  OTA_ERR,
  OtaError,
  type AriUpdate,
  type InboundError,
  type InboundRequest,
  type InboundResult,
  type ResponseContext,
  type WireFormat,
} from "./types";

type ConnectionRow = typeof channelConnections.$inferSelect;
const MAX_RANGE_DAYS = 750;
const err = (e: readonly [string, string, string], message?: string): InboundError => ({
  code: e[0],
  message: message ?? e[1],
  type: e[2],
});

export async function handleInbound(
  slug: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  format: WireFormat,
): Promise<{ status: number; body: string; contentType: string }> {
  const adapter = adapterBySlug(slug);
  if (!adapter) return { status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Unknown channel manager" } }), contentType: "application/json" };

  let req: InboundRequest | null = null;
  let ctx: ResponseContext = { messageType: null };
  let conn: ConnectionRow | null = null;
  let result: InboundResult;

  try {
    req = adapter.parseInbound(rawBody, format);
    ctx = { messageType: req.messageType.replace(/^json:/, ""), echoToken: req.echoToken, soap: req.soap };
    if (!adapter.authenticateInbound(headers, req)) {
      result = { ok: false, errors: [err(OTA_ERR.AUTH, "Invalid channel credentials")] };
    } else {
      conn = await resolveConnection(adapter.provider, req);
      if (!conn) result = { ok: false, errors: [err(OTA_ERR.HOTEL, `Unknown or disabled HotelCode ${"hotelCode" in req ? (req.hotelCode ?? "") : ""}`)] };
      else if (req.kind === "ARI") result = await applyAri(conn, req.updates);
      else if (req.kind === "READ") result = await pullReservations(conn);
      else result = await acknowledge(conn, req.acks);
    }
  } catch (e) {
    if (e instanceof OtaError) {
      if (e.context) ctx = e.context;
      if (!adapter.authenticateInbound(headers, null) && !req) {
        // Unparseable + no valid Basic auth: don't leak parser details to unauthenticated callers
        result = { ok: false, errors: [err(OTA_ERR.AUTH, "Invalid channel credentials")] };
      } else result = { ok: false, errors: [{ code: e.code, message: e.message, type: e.type }] };
    } else {
      console.error("channel inbound error", e);
      result = { ok: false, errors: [err(OTA_ERR.SYSTEM)] };
    }
  }

  const response = adapter.formatResponse(ctx, result, format);
  const errorText = result.ok ? null : result.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
  await db
    .insert(channelSyncLogs)
    .values({
      connectionId: conn?.id ?? null,
      provider: adapter.provider,
      direction: "INBOUND",
      messageType: req?.messageType ?? ctx.messageType ?? "UNKNOWN",
      requestPayload: truncate(rawBody),
      responsePayload: truncate(response.body),
      status: result.ok ? "SUCCESS" : "FAILED",
      error: errorText,
      attempts: 1,
    })
    .catch((e) => console.error("sync log insert failed", e));
  if (conn)
    await db
      .update(channelConnections)
      .set({ lastInboundAt: new Date(), ...(result.ok ? {} : { lastError: `Inbound ${ctx.messageType}: ${errorText}`.slice(0, 1000) }) })
      .where(eq(channelConnections.id, conn.id));
  // OTA convention: business errors travel inside a 200 response
  return { status: 200, ...response };
}

async function resolveConnection(provider: ConnectionRow["provider"], req: InboundRequest): Promise<ConnectionRow | null> {
  let conn: ConnectionRow | undefined;
  if (req.hotelCode) {
    [conn] = await db
      .select()
      .from(channelConnections)
      .where(and(eq(channelConnections.provider, provider), eq(channelConnections.cmPropertyCode, req.hotelCode)));
  } else if (req.kind === "ACK" && req.acks.length) {
    const [b] = await db.select().from(bookings).where(eq(bookings.code, req.acks[0].bookingCode));
    if (b)
      [conn] = await db
        .select()
        .from(channelConnections)
        .where(and(eq(channelConnections.provider, provider), eq(channelConnections.propertyId, b.propertyId)));
  }
  return conn && conn.status !== "DISABLED" ? conn : null;
}

// ─── ARI ─────────────────────────────────────────────────────────────────────

type ResolvedUpdate = AriUpdate & { roomTypeId: string; ratePlanIds: string[]; dates: string[] };

/**
 * Validates every update against the connection's mappings first (all-or-nothing, so a bad code never leaves
 * the calendar half-updated), then writes inventory / rates in one transaction.
 */
async function applyAri(conn: ConnectionRow, updates: AriUpdate[]): Promise<InboundResult> {
  const maps = await db.select().from(channelMappings).where(eq(channelMappings.connectionId, conn.id));
  const rts = await db.select().from(roomTypes).where(eq(roomTypes.propertyId, conn.propertyId));
  const rps = rts.length
    ? await db.select().from(ratePlans).where(inArray(ratePlans.roomTypeId, rts.map((r) => r.id)))
    : [];
  const errors: InboundError[] = [];
  const resolved: ResolvedUpdate[] = [];
  const earliest = addDays(todayIST(), -1); // CMs in other time zones may still send "today"

  for (const u of updates) {
    const roomMaps = maps.filter((m) => m.cmRoomCode === u.roomCode);
    if (!roomMaps.length) {
      errors.push(err(OTA_ERR.ROOM, `Unknown InvTypeCode ${u.roomCode}`));
      continue;
    }
    const roomTypeId = roomMaps[0].roomTypeId;
    let ratePlanIds: string[];
    if (u.rateCode) {
      const m = roomMaps.find((x) => x.cmRateCode === u.rateCode && x.ratePlanId);
      if (!m) {
        errors.push(err(OTA_ERR.RATE, `Unknown RatePlanCode ${u.rateCode} for InvTypeCode ${u.roomCode}`));
        continue;
      }
      ratePlanIds = [m.ratePlanId!];
    } else {
      // Room-level restrictions apply to every rate plan of the room type
      ratePlanIds = rps.filter((p) => p.roomTypeId === roomTypeId).map((p) => p.id);
      if (u.price != null) {
        const mapped = roomMaps.filter((m) => m.ratePlanId);
        if (mapped.length !== 1) {
          errors.push(err(OTA_ERR.RATE, `RatePlanCode is required to update prices of ${u.roomCode}`));
          continue;
        }
        ratePlanIds = [mapped[0].ratePlanId!];
      }
    }
    if (diffDays(u.start, u.end) > MAX_RANGE_DAYS) {
      errors.push(err(OTA_ERR.DATE, `Date range longer than ${MAX_RANGE_DAYS} days`));
      continue;
    }
    const dates = nightsBetween(u.start, addDays(u.end, 1)).filter(
      (d) => d >= earliest && (!u.days || u.days.includes(parseDate(d).getUTCDay())),
    );
    resolved.push({ ...u, roomTypeId, ratePlanIds, dates });
  }
  if (errors.length) return { ok: false, errors };

  const updatedBy = `CM:${conn.provider}`;
  let applied = 0;
  await db.transaction(async (tx) => {
    for (const u of resolved) {
      if (!u.dates.length) continue;
      const rt = rts.find((r) => r.id === u.roomTypeId)!;
      const roomStopSell = !u.rateCode && u.stopSell != null;
      if (u.inventory != null || roomStopSell) await writeInventory(tx, rt, u, roomStopSell, updatedBy);
      const hasRateFields =
        u.price != null ||
        u.minStay != null ||
        u.maxStay !== undefined ||
        u.closedToArrival != null ||
        u.closedToDeparture != null ||
        (u.rateCode && u.stopSell != null);
      if (hasRateFields)
        for (const rpId of u.ratePlanIds) await writeRates(tx, rps.find((p) => p.id === rpId)!, u, updatedBy);
      applied += u.dates.length;
    }
  });
  return { ok: true, kind: "ARI", applied };
}

/** available must equal the CM's count → total = count + sold + held + blocked. */
async function writeInventory(
  tx: Tx,
  rt: typeof roomTypes.$inferSelect,
  u: ResolvedUpdate,
  roomStopSell: boolean,
  updatedBy: string,
) {
  const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy };
  if (u.inventory != null)
    set.total = sql`excluded.total + ${inventory.sold} + ${inventory.held} + ${inventory.blocked}`;
  if (roomStopSell) set.stopSell = sql`excluded.stop_sell`;
  await tx
    .insert(inventory)
    .values(
      u.dates.map((date) => ({
        roomTypeId: rt.id,
        date,
        total: u.inventory ?? rt.totalRooms,
        stopSell: roomStopSell ? u.stopSell! : false,
        updatedBy,
      })),
    )
    .onConflictDoUpdate({ target: [inventory.roomTypeId, inventory.date], set });
}

async function writeRates(tx: Tx, rp: typeof ratePlans.$inferSelect, u: ResolvedUpdate, updatedBy: string) {
  const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy };
  if (u.price != null) set.price = sql`excluded.price`;
  if (u.minStay != null) set.minStay = sql`excluded.min_stay`;
  if (u.maxStay !== undefined) set.maxStay = sql`excluded.max_stay`;
  if (u.closedToArrival != null) set.closedToArrival = sql`excluded.closed_to_arrival`;
  if (u.closedToDeparture != null) set.closedToDeparture = sql`excluded.closed_to_departure`;
  if (u.rateCode && u.stopSell != null) set.stopSell = sql`excluded.stop_sell`;
  await tx
    .insert(rates)
    .values(
      u.dates.map((date) => ({
        ratePlanId: rp.id,
        date,
        price: u.price ?? rp.basePrice,
        minStay: u.minStay ?? 1,
        maxStay: u.maxStay ?? null,
        closedToArrival: u.closedToArrival ?? false,
        closedToDeparture: u.closedToDeparture ?? false,
        stopSell: u.rateCode ? (u.stopSell ?? false) : false,
        updatedBy,
      })),
    )
    .onConflictDoUpdate({ target: [rates.ratePlanId, rates.date], set });
}

// ─── Reservation pull / acknowledgement ──────────────────────────────────────

async function pullReservations(conn: ConnectionRow): Promise<InboundResult> {
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.propertyId, conn.propertyId),
        inArray(bookings.channelSyncStatus, ["PENDING", "RETRYING", "FAILED"]),
        inArray(bookings.status, ["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW", "CANCELLED"]),
      ),
    )
    .orderBy(bookings.updatedAt)
    .limit(50);
  const reservations = await Promise.all(
    rows.map((b) => reservationPayload(b, conn, b.status === "CANCELLED" ? "CANCEL" : "NEW")),
  );
  return { ok: true, kind: "READ", reservations };
}

async function acknowledge(conn: ConnectionRow, acks: { bookingCode: string; cmReference: string | null }[]): Promise<InboundResult> {
  if (!acks.length) return { ok: true, kind: "ACK", acked: 0 };
  const rows = await db
    .update(bookings)
    .set({ channelSyncStatus: "SUCCESS" })
    .where(and(eq(bookings.propertyId, conn.propertyId), inArray(bookings.code, acks.map((a) => a.bookingCode))))
    .returning({ id: bookings.id });
  if (rows.length)
    await db
      .update(channelSyncLogs)
      .set({ status: "SUCCESS", error: "Acknowledged by channel manager (OTA_NotifReportRQ)", nextRetryAt: null })
      .where(
        and(
          eq(channelSyncLogs.direction, "OUTBOUND"),
          inArray(channelSyncLogs.bookingId, rows.map((r) => r.id)),
          inArray(channelSyncLogs.status, ["PENDING", "RETRYING", "FAILED"]),
        ),
      );
  return { ok: true, kind: "ACK", acked: rows.length };
}
