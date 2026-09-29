import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { bookings, channelConnections, channelMappings, channelSyncLogs, properties } from "../../db/schema";

type ConnectionRow = typeof channelConnections.$inferSelect;
type LogRow = typeof channelSyncLogs.$inferSelect;

export async function connectionDtos(rows: ConnectionRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const maps = await db.select().from(channelMappings).where(inArray(channelMappings.connectionId, ids));
  const props = await db
    .select({ id: properties.id, name: properties.name })
    .from(properties)
    .where(inArray(properties.id, rows.map((r) => r.propertyId)));
  const nameOf = new Map(props.map((p) => [p.id, p.name]));
  return rows.map((c) => ({
    id: c.id,
    propertyId: c.propertyId,
    propertyName: nameOf.get(c.propertyId),
    provider: c.provider,
    cmPropertyCode: c.cmPropertyCode,
    status: c.status,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: c.lastOutboundAt?.toISOString() ?? null,
    lastError: c.lastError,
    activatedAt: c.activatedAt?.toISOString() ?? null,
    mappings: maps
      .filter((m) => m.connectionId === c.id)
      .map((m) => ({
        id: m.id,
        roomTypeId: m.roomTypeId,
        ratePlanId: m.ratePlanId,
        cmRoomCode: m.cmRoomCode,
        cmRateCode: m.cmRateCode,
      })),
  }));
}

export async function syncLogDtos(rows: LogRow[]) {
  const bookingIds = [...new Set(rows.map((r) => r.bookingId).filter(Boolean))] as string[];
  const codes = bookingIds.length
    ? await db.select({ id: bookings.id, code: bookings.code }).from(bookings).where(inArray(bookings.id, bookingIds))
    : [];
  const codeOf = new Map(codes.map((c) => [c.id, c.code]));
  return rows.map((l) => ({
    id: l.id,
    connectionId: l.connectionId,
    provider: l.provider,
    direction: l.direction,
    messageType: l.messageType,
    bookingCode: l.bookingId ? (codeOf.get(l.bookingId) ?? null) : null,
    status: l.status,
    error: l.error,
    attempts: l.attempts,
    requestPayload: l.requestPayload,
    responsePayload: l.responsePayload,
    createdAt: l.createdAt.toISOString(),
  }));
}
