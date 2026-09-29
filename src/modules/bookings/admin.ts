// Admin: bookings, payments, refunds (API_CONTRACT §5 Backend B).
import { and, desc, eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import {
  bookings,
  channelSyncLogs,
  ledgerEntries,
  payments,
  paymentStatus,
  paymentTransfers,
  properties,
  refunds,
  refundStatus,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { notFound } from "../../lib/errors";
import { pageParams, paginated } from "../../lib/utils";
import { cancelBooking, retryRefund } from "../../services/bookings";
import { listModifications, modificationDto, quoteModification, requestModification } from "../../services/bookings/modify";
import { bookingDetail } from "../../services/bookings/dto";
import { listBookings } from "../../services/bookings/queries";
import { syncLogDtos } from "../../services/channel/dto";
import { ledgerDto } from "../../services/ledger";

const dateStr = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const adminModifyInput = {
  checkIn: dateStr,
  checkOut: dateStr,
  adults: t.Integer({ minimum: 1, maximum: 60 }),
  children: t.Optional(t.Integer({ minimum: 0, maximum: 60 })),
  rooms: t.Array(
    t.Object({ roomTypeId: t.String({ format: "uuid" }), ratePlanId: t.String({ format: "uuid" }), quantity: t.Integer({ minimum: 1, maximum: 20 }) }),
    { minItems: 1, maxItems: 10 },
  ),
};

const listQuery = t.Object({
  status: t.Optional(t.String()),
  partnerId: t.Optional(t.String({ format: "uuid" })),
  propertyId: t.Optional(t.String({ format: "uuid" })),
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  q: t.Optional(t.String()),
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

export async function adminBookingDetail(id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!b) throw notFound("Booking");
  const [pays, refs, ledger, logs, transfers] = await Promise.all([
    db.select().from(payments).where(eq(payments.bookingId, id)).orderBy(desc(payments.createdAt)),
    db.select().from(refunds).where(eq(refunds.bookingId, id)).orderBy(desc(refunds.createdAt)),
    db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, id)).orderBy(ledgerEntries.createdAt),
    db.select().from(channelSyncLogs).where(eq(channelSyncLogs.bookingId, id)).orderBy(desc(channelSyncLogs.createdAt)),
    db.select().from(paymentTransfers).where(eq(paymentTransfers.bookingId, id)),
  ]);
  return {
    ...(await bookingDetail(b, "admin")),
    partnerId: b.partnerId,
    channelSyncStatus: b.channelSyncStatus,
    payments: pays.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      method: p.method,
      errorCode: p.errorCode,
      errorDescription: p.errorDescription,
      createdAt: p.createdAt.toISOString(),
    })),
    refunds: refs.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      amount: r.amount,
      providerRefundId: r.providerRefundId,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
    transfers: transfers.map((tr) => ({
      id: tr.id,
      providerTransferId: tr.providerTransferId,
      amount: tr.amount,
      amountReversed: tr.amountReversed,
      onHoldUntil: tr.onHoldUntil,
      status: tr.status,
      settlementId: tr.settlementId,
    })),
    ledger: await ledgerDto(ledger),
    channelLogs: await syncLogDtos(logs),
  };
}

async function moneyList(
  anyTable: typeof payments | typeof refunds,
  query: { status?: string; page?: string; limit?: string; bookingId?: string },
  allowed: readonly string[],
) {
  // both tables share bookingId / status / createdAt; typed as one of them for the query builder
  const table = anyTable as typeof payments;
  const { page, limit, offset } = pageParams(query);
  const status = query.status?.toUpperCase();
  const where = and(
    status && allowed.includes(status) ? eq(table.status, status as never) : undefined,
    query.bookingId ? eq(table.bookingId, query.bookingId) : undefined,
  );
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ row: table, code: bookings.code, guestName: bookings.guestName, propertyName: properties.name })
      .from(table)
      .innerJoin(bookings, eq(bookings.id, table.bookingId))
      .innerJoin(properties, eq(properties.id, bookings.propertyId))
      .where(where)
      .orderBy(desc(table.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(table).where(where),
  ]);
  return { rows, total: n, page, limit };
}

export const adminBookingsModule = new Elysia({ prefix: "/admin", tags: ["Admin · Bookings"] })
  .use(authPlugin)
  .get("/bookings", ({ query }) => listBookings(query), { auth: ADMIN_ROLES, query: listQuery })
  .get("/bookings/:id", ({ params }) => adminBookingDetail(params.id), {
    auth: ADMIN_ROLES,
    params: t.Object({ id: t.String({ format: "uuid" }) }),
  })
  .post(
    "/bookings/:id/cancel",
    async ({ params, body, authUser }) => {
      await cancelBooking(params.id, {
        by: "ADMIN",
        reason: body.reason,
        refundOverride: body.refundAmount,
        actorUserId: authUser.id,
      });
      await audit(authUser, "booking.cancel", "booking", params.id, body);
      return adminBookingDetail(params.id);
    },
    {
      auth: ADMIN_ROLES,
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({ reason: t.String({ minLength: 2, maxLength: 500 }), refundAmount: t.Optional(t.Integer({ minimum: 0 })) }),
    },
  )

  .post(
    "/bookings/:id/modify/quote",
    async ({ params, body }) => {
      const b = await db.query.bookings.findFirst({ where: eq(bookings.id, params.id) });
      if (!b) throw notFound("Booking");
      return quoteModification(b, { ...body, children: body.children ?? 0 }, { by: "ADMIN", userId: null });
    },
    { auth: ADMIN_ROLES, params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object(adminModifyInput) },
  )
  .post(
    "/bookings/:id/modify",
    async ({ params, body, authUser }) => {
      const { waiveDifference, reason, ...input } = body;
      const r = await requestModification(
        params.id,
        { ...input, children: input.children ?? 0 },
        { by: "ADMIN", userId: authUser.id, waiveDifference, reason },
      );
      await audit(authUser, "booking.modify", "booking", params.id, body);
      return {
        booking: await adminBookingDetail(params.id),
        modification: await modificationDto(r.modification, r.booking),
        payment: r.payment,
      };
    },
    {
      auth: ADMIN_ROLES,
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        ...adminModifyInput,
        waiveDifference: t.Optional(t.Boolean()),
        reason: t.Optional(t.String({ maxLength: 500 })),
      }),
    },
  )
  .get(
    "/bookings/:id/modifications",
    async ({ params }) => {
      const b = await db.query.bookings.findFirst({ where: eq(bookings.id, params.id) });
      if (!b) throw notFound("Booking");
      return Promise.all((await listModifications(b.id)).map((m) => modificationDto(m, b)));
    },
    { auth: ADMIN_ROLES, params: t.Object({ id: t.String({ format: "uuid" }) }) },
  )
  .get(
    "/payments",
    async ({ query }) => {
      const { rows, total, page, limit } = await moneyList(payments, query, paymentStatus.enumValues);
      return paginated(
        rows.map(({ row, code, guestName, propertyName }) => {
          const p = row as typeof payments.$inferSelect;
          return {
            id: p.id,
            bookingId: p.bookingId,
            bookingCode: code,
            guestName,
            propertyName,
            provider: p.provider,
            providerOrderId: p.providerOrderId,
            providerPaymentId: p.providerPaymentId,
            amount: p.amount,
            currency: p.currency,
            status: p.status,
            method: p.method,
            errorCode: p.errorCode,
            errorDescription: p.errorDescription,
            createdAt: p.createdAt.toISOString(),
          };
        }),
        total,
        page,
        limit,
      );
    },
    {
      auth: ADMIN_ROLES,
      query: t.Object({ status: t.Optional(t.String()), bookingId: t.Optional(t.String()), page: t.Optional(t.String()), limit: t.Optional(t.String()) }),
    },
  )
  .get(
    "/refunds",
    async ({ query }) => {
      const { rows, total, page, limit } = await moneyList(refunds, query, refundStatus.enumValues);
      return paginated(
        rows.map(({ row, code, guestName, propertyName }) => {
          const r = row as unknown as typeof refunds.$inferSelect;
          return {
            id: r.id,
            bookingId: r.bookingId,
            bookingCode: code,
            guestName,
            propertyName,
            paymentId: r.paymentId,
            providerRefundId: r.providerRefundId,
            amount: r.amount,
            status: r.status,
            reason: r.reason,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        total,
        page,
        limit,
      );
    },
    {
      auth: ADMIN_ROLES,
      query: t.Object({ status: t.Optional(t.String()), bookingId: t.Optional(t.String()), page: t.Optional(t.String()), limit: t.Optional(t.String()) }),
    },
  )
  // Re-attempt a refund that Razorpay rejected (network error, insufficient balance…)
  .post(
    "/refunds/:id/retry",
    async ({ params, authUser }) => {
      const refund = await retryRefund(params.id);
      await audit(authUser, "refund.retry", "refund", params.id, { status: refund.status });
      return {
        id: refund.id,
        bookingId: refund.bookingId,
        paymentId: refund.paymentId,
        providerRefundId: refund.providerRefundId,
        amount: refund.amount,
        status: refund.status,
        reason: refund.reason,
        createdAt: refund.createdAt.toISOString(),
      };
    },
    { auth: ADMIN_ROLES, params: t.Object({ id: t.String({ format: "uuid" }) }) },
  );
