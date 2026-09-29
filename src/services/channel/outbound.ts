// Outbound reservation delivery to channel managers + retry schedule.
// Every push is a channel_sync_logs row (OUTBOUND). Failures retry after 1, 5, 15, 60 minutes, then daily,
// up to MAX_ATTEMPTS. Independently, un-acknowledged reservations stay available for pull via OTA_ReadRQ.
import { and, eq, inArray, lte } from "drizzle-orm";
import { env } from "../../config/env";
import { db, type Tx } from "../../db";
import { bookingRooms, bookings, channelConnections, channelMappings, channelSyncLogs } from "../../db/schema";
import { ADAPTERS } from "./providers";
import type { ReservationKind, ReservationPayload } from "./types";

type Exec = typeof db | Tx;
type ConnectionRow = typeof channelConnections.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;

const BACKOFF_MINUTES = [1, 5, 15, 60];
const DAILY = 24 * 60;
export const MAX_ATTEMPTS = 10;
const MAX_PAYLOAD = 200_000;

export const truncate = (s: string | null | undefined) =>
  s == null ? null : s.length > MAX_PAYLOAD ? `${s.slice(0, MAX_PAYLOAD)}…[truncated]` : s;

export async function activeConnectionFor(propertyId: string, exec: Exec = db): Promise<ConnectionRow | null> {
  const [conn] = await exec
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.propertyId, propertyId), eq(channelConnections.status, "ACTIVE")));
  return conn ?? null;
}

/** Booking → provider-neutral reservation, with our room/rate ids translated to the CM's codes. */
export async function reservationPayload(b: BookingRow, conn: ConnectionRow, kind: ReservationKind): Promise<ReservationPayload> {
  const rooms = await db.select().from(bookingRooms).where(eq(bookingRooms.bookingId, b.id));
  const maps = await db.select().from(channelMappings).where(eq(channelMappings.connectionId, conn.id));
  return {
    kind,
    code: b.code,
    hotelCode: conn.cmPropertyCode,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    adults: b.adults,
    children: b.children,
    guest: { name: b.guestName, email: b.guestEmail, phone: b.guestPhone },
    specialRequests: b.specialRequests,
    currency: b.currency,
    roomAmount: b.roomAmount,
    roomTax: b.roomTax,
    discountAmount: b.discountAmount,
    totalAmount: b.totalAmount,
    paidOnline: true,
    rooms: rooms.map((r) => {
      const exact = maps.find((m) => m.roomTypeId === r.roomTypeId && m.ratePlanId === r.ratePlanId);
      const room = exact ?? maps.find((m) => m.roomTypeId === r.roomTypeId);
      return {
        cmRoomCode: room?.cmRoomCode ?? r.roomTypeId,
        cmRateCode: exact?.cmRateCode ?? room?.cmRateCode ?? null,
        roomTypeName: r.roomTypeName,
        ratePlanName: r.ratePlanName,
        quantity: r.quantity,
        adults: r.adults,
        children: r.children,
        nightly: r.nightlyPrices,
        amount: r.amount,
      };
    }),
  };
}

/** Creates a PENDING outbound log for the booking's CM (if the property has an active connection) and tries it. */
export async function queueReservationPush(bookingId: string, kind: ReservationKind) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b) return;
  const conn = await activeConnectionFor(b.propertyId);
  if (!conn) return;
  const msg = ADAPTERS[conn.provider].buildReservationMessage(await reservationPayload(b, conn, kind));
  const [log] = await db
    .insert(channelSyncLogs)
    .values({
      connectionId: conn.id,
      provider: conn.provider,
      direction: "OUTBOUND",
      messageType: `${msg.messageType}:${kind}`,
      bookingId: b.id,
      requestPayload: truncate(msg.body),
      status: "PENDING",
      nextRetryAt: new Date(),
    })
    .returning();
  await db.update(bookings).set({ channelSyncStatus: "PENDING" }).where(eq(bookings.id, b.id));
  await attemptPush(log.id);
}

/**
 * Sends one outbound log. `force` (admin retry) ignores the schedule; otherwise the row is claimed with a
 * compare-and-set on next_retry_at so overlapping workers never double-send.
 */
export async function attemptPush(logId: string, force = false) {
  const claimUntil = new Date(Date.now() + 10 * 60_000);
  const [log] = await db
    .update(channelSyncLogs)
    .set({ nextRetryAt: claimUntil })
    .where(
      and(
        eq(channelSyncLogs.id, logId),
        eq(channelSyncLogs.direction, "OUTBOUND"),
        force ? undefined : inArray(channelSyncLogs.status, ["PENDING", "RETRYING"]),
        force ? undefined : lte(channelSyncLogs.nextRetryAt, new Date()),
      ),
    )
    .returning();
  if (!log) return null;

  const [conn] = log.connectionId
    ? await db.select().from(channelConnections).where(eq(channelConnections.id, log.connectionId))
    : [];
  const endpoint = env.channelManagers[log.provider].endpoint;
  if (!conn || conn.status !== "ACTIVE") {
    return finish(log.id, { status: "FAILED", error: "Channel connection is not active", nextRetryAt: null });
  }
  if (!endpoint) {
    // Nothing to push to yet: the CM can still pull it with OTA_ReadRQ. Admin "retry" re-checks later.
    return finish(log.id, {
      status: "PENDING",
      error: `CM_${log.provider}_ENDPOINT not configured — reservation is available for pull (OTA_ReadRQ)`,
      nextRetryAt: null,
    });
  }

  const adapter = ADAPTERS[log.provider];
  const res = await adapter.pushReservation(
    { body: log.requestPayload ?? "", contentType: "text/xml; charset=utf-8", messageType: log.messageType },
    endpoint,
  );
  const attempts = log.attempts + 1;
  if (res.ok) {
    await db
      .update(channelConnections)
      .set({ lastOutboundAt: new Date(), lastError: null })
      .where(eq(channelConnections.id, conn.id));
    if (log.bookingId) await db.update(bookings).set({ channelSyncStatus: "SUCCESS" }).where(eq(bookings.id, log.bookingId));
    return finish(log.id, { status: "SUCCESS", attempts, error: null, response: res.responseBody, nextRetryAt: null });
  }
  const exhausted = attempts >= MAX_ATTEMPTS;
  const delay = BACKOFF_MINUTES[attempts - 1] ?? DAILY;
  await db
    .update(channelConnections)
    .set({ lastOutboundAt: new Date(), lastError: `Push ${log.messageType}: ${res.error}`.slice(0, 1000) })
    .where(eq(channelConnections.id, conn.id));
  if (log.bookingId)
    await db
      .update(bookings)
      .set({ channelSyncStatus: exhausted ? "FAILED" : "RETRYING" })
      .where(eq(bookings.id, log.bookingId));
  return finish(log.id, {
    status: exhausted ? "FAILED" : "RETRYING",
    attempts,
    error: res.error ?? "Push failed",
    response: res.responseBody,
    nextRetryAt: exhausted ? null : new Date(Date.now() + delay * 60_000),
  });
}

async function finish(
  id: string,
  p: { status: "PENDING" | "SUCCESS" | "FAILED" | "RETRYING"; attempts?: number; error: string | null; response?: string; nextRetryAt: Date | null },
) {
  const [row] = await db
    .update(channelSyncLogs)
    .set({
      status: p.status,
      attempts: p.attempts,
      error: p.error,
      responsePayload: p.response !== undefined ? truncate(p.response) : undefined,
      nextRetryAt: p.nextRetryAt,
    })
    .where(eq(channelSyncLogs.id, id))
    .returning();
  return row;
}

/** Job: pushes whose retry time has come. */
export async function retryDuePushes(): Promise<number> {
  const due = await db
    .select({ id: channelSyncLogs.id })
    .from(channelSyncLogs)
    .where(
      and(
        eq(channelSyncLogs.direction, "OUTBOUND"),
        inArray(channelSyncLogs.status, ["PENDING", "RETRYING"]),
        lte(channelSyncLogs.nextRetryAt, new Date()),
      ),
    )
    .limit(50);
  let n = 0;
  for (const { id } of due) if (await attemptPush(id).catch((e) => console.error("CM push failed", e))) n++;
  return n;
}
