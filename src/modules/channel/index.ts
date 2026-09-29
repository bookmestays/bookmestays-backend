// Channel managers: inbound CM API (§7), admin monitoring (§5) and partner connection setup (§6).
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import {
  channelConnections,
  channelConnectionStatus,
  channelMappings,
  channelProvider,
  channelSyncLogs,
  properties,
  ratePlans,
  roomTypes,
  syncStatus,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { conflict, notFound, unprocessable } from "../../lib/errors";
import { pageParams, paginated } from "../../lib/utils";
import { connectionDtos, syncLogDtos } from "../../services/channel/dto";
import { handleInbound } from "../../services/channel/inbound";
import { attemptPush } from "../../services/channel/outbound";
import { adapterBySlug, PROVIDERS, providerInfo } from "../../services/channel/providers";

type Provider = (typeof channelProvider.enumValues)[number];
type ConnStatus = (typeof channelConnectionStatus.enumValues)[number];
type SyncStatus = (typeof syncStatus.enumValues)[number];
const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const providerT = t.Union(PROVIDERS.map((p) => t.Literal(p)));

// ─── Inbound (called by the channel managers) ────────────────────────────────

const respond = (r: { status: number; body: string; contentType: string }) =>
  new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } });

export const channelInboundModule = new Elysia({ prefix: "/channel", tags: ["Channel manager API"] })
  .post(
    "/:provider/ota",
    async ({ params, body, headers }) => respond(await handleInbound(params.provider, String(body ?? ""), headers, "xml")),
    { parse: "text", params: t.Object({ provider: t.String() }) },
  )
  .post(
    "/:provider/json",
    async ({ params, body, headers }) => respond(await handleInbound(params.provider, String(body ?? ""), headers, "json")),
    { parse: "text", params: t.Object({ provider: t.String() }) },
  )
  .get(
    "/:provider/health",
    ({ params }) => {
      const a = adapterBySlug(params.provider);
      if (!a) throw notFound("Channel manager");
      const info = providerInfo(a.provider);
      return {
        ok: true,
        provider: a.provider,
        label: a.label,
        time: new Date().toISOString(),
        inboundConfigured: info.inboundConfigured,
        supportedMessages: [
          "OTA_HotelAvailNotifRQ",
          "OTA_HotelRateAmountNotifRQ",
          "OTA_HotelInvCountNotifRQ",
          "OTA_ReadRQ",
          "OTA_NotifReportRQ",
        ],
      };
    },
    { params: t.Object({ provider: t.String() }) },
  );

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function setChannelManaged(propertyId: string, value: boolean) {
  await db.update(properties).set({ channelManaged: value }).where(eq(properties.id, propertyId));
}

async function listLogs(q: {
  connectionId?: string;
  status?: string;
  provider?: string;
  direction?: string;
  page?: string;
  limit?: string;
}) {
  const { page, limit, offset } = pageParams(q);
  const status = q.status?.toUpperCase();
  const provider = q.provider?.toUpperCase();
  const direction = q.direction?.toUpperCase();
  const where = and(
    q.connectionId ? eq(channelSyncLogs.connectionId, q.connectionId) : undefined,
    status && (syncStatus.enumValues as readonly string[]).includes(status) ? eq(channelSyncLogs.status, status as SyncStatus) : undefined,
    provider && (PROVIDERS as string[]).includes(provider) ? eq(channelSyncLogs.provider, provider as Provider) : undefined,
    direction === "INBOUND" || direction === "OUTBOUND" ? eq(channelSyncLogs.direction, direction) : undefined,
  );
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(channelSyncLogs).where(where).orderBy(desc(channelSyncLogs.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(channelSyncLogs).where(where),
  ]);
  return paginated(await syncLogDtos(rows), n, page, limit);
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export const adminChannelModule = new Elysia({ prefix: "/admin/channel", tags: ["Admin · Channel managers"] })
  .use(authPlugin)
  .get("/providers", () => PROVIDERS.map(providerInfo), { auth: ADMIN_ROLES })
  .get(
    "/connections",
    async ({ query }) => {
      const provider = query.provider?.toUpperCase();
      const status = query.status?.toUpperCase();
      const rows = await db
        .select()
        .from(channelConnections)
        .where(
          and(
            provider && (PROVIDERS as string[]).includes(provider) ? eq(channelConnections.provider, provider as Provider) : undefined,
            status && (channelConnectionStatus.enumValues as readonly string[]).includes(status)
              ? eq(channelConnections.status, status as ConnStatus)
              : undefined,
          ),
        )
        .orderBy(desc(channelConnections.updatedAt));
      return connectionDtos(rows);
    },
    { auth: ADMIN_ROLES, query: t.Object({ provider: t.Optional(t.String()), status: t.Optional(t.String()) }) },
  )
  .patch(
    "/connections/:id",
    async ({ params, body, authUser }) => {
      const [conn] = await db.select().from(channelConnections).where(eq(channelConnections.id, params.id));
      if (!conn) throw notFound("Connection");
      const [u] = await db
        .update(channelConnections)
        .set({
          status: body.status,
          activatedAt: body.status === "ACTIVE" ? (conn.activatedAt ?? new Date()) : conn.activatedAt,
          ...(body.status === "ACTIVE" ? { lastError: null } : {}),
        })
        .where(eq(channelConnections.id, conn.id))
        .returning();
      await setChannelManaged(conn.propertyId, body.status === "ACTIVE");
      await audit(authUser, "channel.connection_status", "channel_connection", conn.id, body);
      return (await connectionDtos([u]))[0];
    },
    {
      auth: ADMIN_ROLES,
      params: idParams,
      body: t.Object({ status: t.Union(channelConnectionStatus.enumValues.map((s) => t.Literal(s))) }),
    },
  )
  .get("/logs", ({ query }) => listLogs(query), {
    auth: ADMIN_ROLES,
    query: t.Object({
      connectionId: t.Optional(t.String({ format: "uuid" })),
      status: t.Optional(t.String()),
      provider: t.Optional(t.String()),
      direction: t.Optional(t.String()),
      page: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  })
  .post(
    "/logs/:id/retry",
    async ({ params, authUser }) => {
      const [log] = await db.select().from(channelSyncLogs).where(eq(channelSyncLogs.id, params.id));
      if (!log) throw notFound("Sync log");
      if (log.direction !== "OUTBOUND") throw unprocessable("Only outbound messages can be retried");
      if (log.status === "SUCCESS") throw conflict("This message was already delivered");
      const row = (await attemptPush(log.id, true)) ?? log;
      await audit(authUser, "channel.retry", "channel_sync_log", log.id);
      return (await syncLogDtos([row]))[0];
    },
    { auth: ADMIN_ROLES, params: idParams },
  );

// ─── Partner ─────────────────────────────────────────────────────────────────

async function ownProperty(id: string, partnerId: string) {
  const [p] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.partnerId, partnerId)));
  if (!p) throw notFound("Property");
  return p;
}

async function connectionOf(propertyId: string) {
  const [conn] = await db.select().from(channelConnections).where(eq(channelConnections.propertyId, propertyId));
  return conn ?? null;
}

async function requireConnection(propertyId: string) {
  const conn = await connectionOf(propertyId);
  if (!conn || conn.status === "DISABLED") throw notFound("Channel connection");
  return conn;
}

export const partnerChannelModule = new Elysia({ prefix: "/partner/properties/:id/channel", tags: ["Partner · Channel manager"] })
  .use(authPlugin)
  .get(
    "/",
    async ({ params, partnerId }) => {
      const p = await ownProperty(params.id, partnerId);
      const conn = await connectionOf(p.id);
      const rts = await db.select().from(roomTypes).where(eq(roomTypes.propertyId, p.id)).orderBy(asc(roomTypes.sort));
      const rps = rts.length
        ? await db.select().from(ratePlans).where(inArray(ratePlans.roomTypeId, rts.map((r) => r.id))).orderBy(asc(ratePlans.sort))
        : [];
      return {
        connection: conn && conn.status !== "DISABLED" ? (await connectionDtos([conn]))[0] : null,
        roomTypes: rts.map((rt) => ({
          id: rt.id,
          name: rt.name,
          status: rt.status,
          ratePlans: rps
            .filter((rp) => rp.roomTypeId === rt.id)
            .map((rp) => ({ id: rp.id, name: rp.name, mealPlan: rp.mealPlan, isActive: rp.isActive })),
        })),
        providers: PROVIDERS.map(providerInfo),
      };
    },
    { partner: "inventory", params: idParams },
  )
  .post(
    "/",
    async ({ params, body, partnerId, authUser }) => {
      const p = await ownProperty(params.id, partnerId);
      const code = body.cmPropertyCode.trim();
      const [taken] = await db
        .select({ id: channelConnections.id, propertyId: channelConnections.propertyId })
        .from(channelConnections)
        .where(and(eq(channelConnections.provider, body.provider), eq(channelConnections.cmPropertyCode, code)));
      if (taken && taken.propertyId !== p.id)
        throw conflict("This channel manager property code is already connected to another property");
      const existing = await connectionOf(p.id);
      if (existing?.status === "ACTIVE")
        throw conflict("This property is already connected to a channel manager. Disconnect it first.");
      let conn;
      if (existing) {
        conn = await db.transaction(async (tx) => {
          await tx.delete(channelMappings).where(eq(channelMappings.connectionId, existing.id));
          const [u] = await tx
            .update(channelConnections)
            .set({ provider: body.provider, cmPropertyCode: code, status: "PENDING", activatedAt: null, lastError: null })
            .where(eq(channelConnections.id, existing.id))
            .returning();
          return u;
        });
      } else {
        [conn] = await db
          .insert(channelConnections)
          .values({ propertyId: p.id, provider: body.provider, cmPropertyCode: code, status: "PENDING" })
          .returning();
      }
      await audit(authUser, "channel.connect", "channel_connection", conn.id, body);
      return (await connectionDtos([conn]))[0];
    },
    {
      partner: "inventory",
      params: idParams,
      body: t.Object({ provider: providerT, cmPropertyCode: t.String({ minLength: 1, maxLength: 80 }) }),
    },
  )
  .put(
    "/mappings",
    async ({ params, body, partnerId, authUser }) => {
      const p = await ownProperty(params.id, partnerId);
      const conn = await requireConnection(p.id);
      const rts = await db.select({ id: roomTypes.id }).from(roomTypes).where(eq(roomTypes.propertyId, p.id));
      const rtIds = new Set(rts.map((r) => r.id));
      const rps = rts.length
        ? await db
            .select({ id: ratePlans.id, roomTypeId: ratePlans.roomTypeId })
            .from(ratePlans)
            .where(inArray(ratePlans.roomTypeId, [...rtIds]))
        : [];
      const seen = new Set<string>();
      const roomCodeOwner = new Map<string, string>();
      const rows = body.mappings.map((m, i) => {
        const cmRoomCode = m.cmRoomCode.trim();
        const cmRateCode = m.cmRateCode?.trim() || null;
        if (!rtIds.has(m.roomTypeId)) throw unprocessable(`Mapping ${i + 1}: room type does not belong to this property`);
        if (m.ratePlanId && !rps.some((rp) => rp.id === m.ratePlanId && rp.roomTypeId === m.roomTypeId))
          throw unprocessable(`Mapping ${i + 1}: rate plan does not belong to the room type`);
        if (m.ratePlanId && !cmRateCode) throw unprocessable(`Mapping ${i + 1}: CM rate code is required for a rate plan`);
        const key = `${cmRoomCode}|${cmRateCode ?? ""}`;
        if (seen.has(key)) throw unprocessable(`Mapping ${i + 1}: duplicate CM room/rate code ${key.replace("|", " / ")}`);
        seen.add(key);
        const owner = roomCodeOwner.get(cmRoomCode);
        if (owner && owner !== m.roomTypeId)
          throw unprocessable(`CM room code ${cmRoomCode} is mapped to two different room types`);
        roomCodeOwner.set(cmRoomCode, m.roomTypeId);
        return { connectionId: conn.id, roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId ?? null, cmRoomCode, cmRateCode };
      });
      await db.transaction(async (tx) => {
        await tx.delete(channelMappings).where(eq(channelMappings.connectionId, conn.id));
        if (rows.length) await tx.insert(channelMappings).values(rows);
      });
      await audit(authUser, "channel.mappings", "channel_connection", conn.id, { count: rows.length });
      return (await connectionDtos([conn]))[0];
    },
    {
      partner: "inventory",
      params: idParams,
      body: t.Object({
        mappings: t.Array(
          t.Object({
            roomTypeId: t.String({ format: "uuid" }),
            ratePlanId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
            cmRoomCode: t.String({ minLength: 1, maxLength: 80 }),
            cmRateCode: t.Optional(t.Union([t.String({ maxLength: 80 }), t.Null()])),
          }),
          { maxItems: 500 },
        ),
      }),
    },
  )
  .post(
    "/activate",
    async ({ params, partnerId, authUser }) => {
      const p = await ownProperty(params.id, partnerId);
      const conn = await requireConnection(p.id);
      const active = await db
        .select({ id: roomTypes.id, name: roomTypes.name })
        .from(roomTypes)
        .where(and(eq(roomTypes.propertyId, p.id), eq(roomTypes.status, "ACTIVE")));
      const maps = await db.select().from(channelMappings).where(eq(channelMappings.connectionId, conn.id));
      const missing = active.filter((rt) => !maps.some((m) => m.roomTypeId === rt.id));
      if (!maps.length || missing.length)
        throw unprocessable(
          missing.length
            ? `Map every active room type before activating: ${missing.map((m) => m.name).join(", ")}`
            : "Add room mappings before activating",
          { missingRoomTypeIds: missing.map((m) => m.id) },
        );
      const [u] = await db
        .update(channelConnections)
        .set({ status: "ACTIVE", activatedAt: new Date(), lastError: null })
        .where(eq(channelConnections.id, conn.id))
        .returning();
      await setChannelManaged(p.id, true);
      await audit(authUser, "channel.activate", "channel_connection", conn.id);
      return (await connectionDtos([u]))[0];
    },
    { partner: "inventory", params: idParams },
  )
  .delete(
    "/",
    async ({ params, partnerId, authUser }) => {
      const p = await ownProperty(params.id, partnerId);
      const conn = await requireConnection(p.id);
      await db.update(channelConnections).set({ status: "DISABLED" }).where(eq(channelConnections.id, conn.id));
      await setChannelManaged(p.id, false);
      await audit(authUser, "channel.disconnect", "channel_connection", conn.id);
      return { ok: true };
    },
    { partner: "inventory", params: idParams },
  )
  .get(
    "/logs",
    async ({ params, partnerId, query }) => {
      const p = await ownProperty(params.id, partnerId);
      const conn = await connectionOf(p.id);
      if (!conn) return paginated([], 0, 1, 20);
      return listLogs({ ...query, connectionId: conn.id });
    },
    {
      partner: "inventory",
      params: idParams,
      query: t.Object({ status: t.Optional(t.String()), page: t.Optional(t.String()), limit: t.Optional(t.String()) }),
    },
  );
