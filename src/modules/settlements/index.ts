// Settlements, partner ledger and manual adjustments (API_CONTRACT §5/§6 Backend B).
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { ledgerEntries, partners, settlements, settlementStatus } from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { notFound, unprocessable } from "../../lib/errors";
import { addDays, pageParams, paginated } from "../../lib/utils";
import { ledgerDto, partnerBalance } from "../../services/ledger";
import {
  approveSettlement,
  generateSettlements,
  holdSettlement,
  markSettlementPaid,
  settlementDetail,
  settlementDtos,
} from "../../services/settlements";

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const pageQuery = { page: t.Optional(t.String()), limit: t.Optional(t.String()) };

async function listSettlements(q: { status?: string; partnerId?: string; page?: string; limit?: string }) {
  const { page, limit, offset } = pageParams(q);
  const status = q.status?.toUpperCase();
  const where = and(
    q.partnerId ? eq(settlements.partnerId, q.partnerId) : undefined,
    status && (settlementStatus.enumValues as readonly string[]).includes(status)
      ? eq(settlements.status, status as (typeof settlementStatus.enumValues)[number])
      : undefined,
  );
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(settlements).where(where).orderBy(desc(settlements.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(settlements).where(where),
  ]);
  return paginated(await settlementDtos(rows), n, page, limit);
}

async function getSettlement(id: string, partnerId?: string) {
  const [s] = await db
    .select()
    .from(settlements)
    .where(and(eq(settlements.id, id), partnerId ? eq(settlements.partnerId, partnerId) : undefined));
  if (!s) throw notFound("Settlement");
  return s;
}

async function ledgerPage(partnerId: string, q: { from?: string; to?: string; page?: string; limit?: string }) {
  const { page, limit, offset } = pageParams(q);
  // from/to are IST calendar dates (inclusive)
  const where = and(
    eq(ledgerEntries.partnerId, partnerId),
    q.from ? gte(ledgerEntries.createdAt, new Date(`${q.from}T00:00:00+05:30`)) : undefined,
    q.to ? lt(ledgerEntries.createdAt, new Date(`${addDays(q.to, 1)}T00:00:00+05:30`)) : undefined,
  );
  const [rows, [{ n }], balance] = await Promise.all([
    db.select().from(ledgerEntries).where(where).orderBy(desc(ledgerEntries.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntries).where(where),
    partnerBalance(partnerId),
  ]);
  return { ...paginated(await ledgerDto(rows), n, page, limit), balance };
}

const dateQ = t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }));

export const settlementsModule = new Elysia({ tags: ["Settlements"] })
  .use(authPlugin)

  // ─── Admin ──────────────────────────────────────────────────────────────────
  .get("/admin/settlements", ({ query }) => listSettlements(query), {
    auth: ADMIN_ROLES,
    query: t.Object({ status: t.Optional(t.String()), partnerId: t.Optional(t.String({ format: "uuid" })), ...pageQuery }),
  })
  .get("/admin/settlements/:id", async ({ params }) => settlementDetail(await getSettlement(params.id), { includeInternal: true }), {
    auth: ADMIN_ROLES,
    params: idParams,
  })
  .post(
    "/admin/settlements/run",
    async ({ authUser }) => {
      const created = await generateSettlements();
      await audit(authUser, "settlement.run", "settlement", null, { created });
      return { created };
    },
    { auth: ADMIN_ROLES },
  )
  .post(
    "/admin/settlements/:id/approve",
    async ({ params, authUser }) => {
      const s = await approveSettlement(params.id, authUser.id);
      await audit(authUser, "settlement.approve", "settlement", params.id, { status: s.status, method: s.method });
      return settlementDetail(s, { includeInternal: true });
    },
    { auth: ADMIN_ROLES, params: idParams },
  )
  .post(
    "/admin/settlements/:id/mark-paid",
    async ({ params, body, authUser }) => {
      const s = await markSettlementPaid(params.id, body.utr.trim(), authUser.id);
      await audit(authUser, "settlement.mark_paid", "settlement", params.id, body);
      return settlementDetail(s, { includeInternal: true });
    },
    { auth: ADMIN_ROLES, params: idParams, body: t.Object({ utr: t.String({ minLength: 4, maxLength: 60 }) }) },
  )
  .post(
    "/admin/settlements/:id/hold",
    async ({ params, body, authUser }) => {
      const s = await holdSettlement(params.id, body.reason.trim());
      await audit(authUser, "settlement.hold", "settlement", params.id, body);
      return settlementDetail(s, { includeInternal: true });
    },
    { auth: ADMIN_ROLES, params: idParams, body: t.Object({ reason: t.String({ minLength: 2, maxLength: 500 }) }) },
  )
  .post(
    "/admin/partners/:id/adjustments",
    async ({ params, body, authUser }) => {
      if (body.amount === 0) throw unprocessable("Amount cannot be zero");
      const [p] = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, params.id));
      if (!p) throw notFound("Partner");
      const [row] = await db
        .insert(ledgerEntries)
        .values({
          partnerId: p.id,
          type: "ADJUSTMENT",
          amount: body.amount,
          description: body.description.trim(),
          meta: { by: authUser.id },
        })
        .returning();
      await audit(authUser, "partner.adjustment", "partner", p.id, body);
      const [dto] = await ledgerDto([row]);
      return dto;
    },
    {
      auth: ADMIN_ROLES,
      params: idParams,
      body: t.Object({ amount: t.Integer(), description: t.String({ minLength: 2, maxLength: 500 }) }),
    },
  )
  .get("/admin/partners/:id/ledger", ({ params, query }) => ledgerPage(params.id, query), {
    auth: ADMIN_ROLES,
    params: idParams,
    query: t.Object({ from: dateQ, to: dateQ, ...pageQuery }),
  })

  // ─── Partner ────────────────────────────────────────────────────────────────
  .get("/partner/settlements", ({ query, partnerId }) => listSettlements({ ...query, partnerId }), {
    partner: "payouts",
    query: t.Object({ status: t.Optional(t.String()), ...pageQuery }),
  })
  .get(
    "/partner/settlements/:id",
    async ({ params, partnerId }) => settlementDetail(await getSettlement(params.id, partnerId)),
    { partner: "payouts", params: idParams },
  )
  .get("/partner/ledger", ({ query, partnerId }) => ledgerPage(partnerId, query), {
    partner: "payouts",
    query: t.Object({ from: dateQ, to: dateQ, ...pageQuery }),
  });
