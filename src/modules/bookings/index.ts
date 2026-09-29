// Guest booking endpoints (API_CONTRACT §4).
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { bookings, payments } from "../../db/schema";
import { authPlugin } from "../../lib/auth";
import { AppError, notFound } from "../../lib/errors";
import { pageParams, paginated, todayIST } from "../../lib/utils";
import {
  cancelBooking,
  cancellationPreview,
  confirmPayment,
  createBooking,
  paymentOrderDto,
  retryPayment,
} from "../../services/bookings";
import { bookingDetail, bookingSummaries } from "../../services/bookings/dto";
import {
  confirmModificationPayment,
  listModifications,
  modificationDto,
  modificationEligibility,
  modificationPaymentOrder,
  quoteModification,
  requestModification,
  cancelPendingModifications,
} from "../../services/bookings/modify";
import { bookingModifications } from "../../db/schema";
import { buildQuote } from "../../services/pricing";
import { isMockPayments, verifyPaymentSignature } from "../../services/razorpay";

export const dateStr = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const uuid = t.String({ format: "uuid" });

const bookingInput = {
  propertyId: uuid,
  checkIn: dateStr,
  checkOut: dateStr,
  adults: t.Integer({ minimum: 1, maximum: 60 }),
  children: t.Optional(t.Integer({ minimum: 0, maximum: 60 })),
  rooms: t.Array(
    t.Object({ roomTypeId: uuid, ratePlanId: uuid, quantity: t.Integer({ minimum: 1, maximum: 20 }) }),
    { minItems: 1, maxItems: 10 },
  ),
  couponCode: t.Optional(t.String({ maxLength: 40 })),
};

const modifyInput = {
  checkIn: dateStr,
  checkOut: dateStr,
  adults: t.Integer({ minimum: 1, maximum: 60 }),
  children: t.Optional(t.Integer({ minimum: 0, maximum: 60 })),
  rooms: bookingInput.rooms,
};

async function ownBooking(code: string, userId: string) {
  const [b] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.code, code.toUpperCase()), eq(bookings.userId, userId)));
  if (!b) throw notFound("Booking");
  return b;
}

export const guestBookingsModule = new Elysia({ prefix: "/bookings", tags: ["Bookings"] })
  .use(authPlugin)

  .post(
    "/quote",
    async ({ body, user }) => (await buildQuote(db, { ...body, children: body.children ?? 0 }, { userId: user?.id })).quote,
    { body: t.Object(bookingInput) },
  )

  .post(
    "/",
    async ({ body, authUser }) => {
      const { booking, payment } = await createBooking(authUser.id, { ...body, children: body.children ?? 0 });
      return { booking: await bookingDetail(booking, "guest"), payment: paymentOrderDto(booking, payment) };
    },
    {
      auth: true,
      body: t.Object({
        ...bookingInput,
        guest: t.Object({
          name: t.String({ minLength: 2, maxLength: 160 }),
          email: t.String({ format: "email", maxLength: 255 }),
          phone: t.String({ minLength: 8, maxLength: 20 }),
        }),
        specialRequests: t.Optional(t.String({ maxLength: 1000 })),
      }),
    },
  )

  .post(
    "/:code/verify-payment",
    async ({ params, body, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      const [payment] = await db
        .select()
        .from(payments)
        .where(and(eq(payments.bookingId, b.id), eq(payments.providerOrderId, body.razorpayOrderId)));
      if (!payment) throw notFound("Payment");
      if (!verifyPaymentSignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature))
        throw new AppError(400, "INVALID_SIGNATURE", "We could not verify this payment. If money was debited it will be refunded automatically.");
      const { booking, outcome } = await confirmPayment({
        orderId: body.razorpayOrderId,
        paymentId: body.razorpayPaymentId,
        verifyWithGateway: !isMockPayments(),
      });
      if (outcome === "REFUND_REQUIRED")
        throw new AppError(
          409,
          "BOOKING_CANCELLED",
          "Sorry — the rooms were no longer available when your payment completed. A full refund has been initiated.",
          { code: booking.code },
        );
      return bookingDetail(booking, "guest");
    },
    {
      auth: true,
      params: t.Object({ code: t.String() }),
      body: t.Object({
        razorpayOrderId: t.String({ minLength: 1 }),
        razorpayPaymentId: t.String({ minLength: 1 }),
        razorpaySignature: t.String({ minLength: 1 }),
      }),
    },
  )

  .post(
    "/:code/retry-payment",
    async ({ params, authUser }) => retryPayment(await ownBooking(params.code, authUser.id)),
    { auth: true, params: t.Object({ code: t.String() }) },
  )

  .get(
    "/",
    async ({ query, authUser }) => {
      const { page, limit, offset } = pageParams(query);
      const today = todayIST();
      const tabFilter =
        query.tab === "upcoming"
          ? or(
              and(inArray(bookings.status, ["CONFIRMED", "CHECKED_IN"]), gte(bookings.checkOut, today)),
              and(eq(bookings.status, "PENDING_PAYMENT"), gt(bookings.holdExpiresAt, new Date())),
            )
          : query.tab === "past"
            ? or(
                inArray(bookings.status, ["COMPLETED", "NO_SHOW"]),
                and(inArray(bookings.status, ["CONFIRMED", "CHECKED_IN"]), lt(bookings.checkOut, today)),
              )
            : query.tab === "cancelled"
              ? eq(bookings.status, "CANCELLED")
              : and(ne(bookings.status, "EXPIRED"), ne(bookings.status, "PENDING_PAYMENT"));
      const where = and(eq(bookings.userId, authUser.id), tabFilter);
      const order =
        query.tab === "upcoming"
          ? [asc(bookings.checkIn)]
          : query.tab === "cancelled"
            ? [desc(bookings.cancelledAt)]
            : [desc(bookings.checkIn)];
      const [rows, [{ n }]] = await Promise.all([
        db.select().from(bookings).where(where).orderBy(...order).limit(limit).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(where),
      ]);
      return paginated(await bookingSummaries(rows), n, page, limit);
    },
    {
      auth: true,
      query: t.Object({
        tab: t.Optional(t.Union([t.Literal("upcoming"), t.Literal("past"), t.Literal("cancelled")])),
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  .get("/:code", async ({ params, authUser }) => bookingDetail(await ownBooking(params.code, authUser.id), "guest"), {
    auth: true,
    params: t.Object({ code: t.String() }),
  })

  .get(
    "/:code/cancellation-preview",
    async ({ params, authUser }) => cancellationPreview(await ownBooking(params.code, authUser.id)),
    { auth: true, params: t.Object({ code: t.String() }) },
  )

  .post(
    "/:code/cancel",
    async ({ params, body, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      const cancelled = await cancelBooking(b.id, { by: "GUEST", reason: body?.reason, actorUserId: authUser.id });
      return bookingDetail(cancelled, "guest");
    },
    {
      auth: true,
      params: t.Object({ code: t.String() }),
      body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) })),
    },
  )
  // ─── Booking changes (dates / guests / rooms) ────────────────────────────
  .get(
    "/:code/modifications",
    async ({ params, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      const rows = await listModifications(b.id);
      return {
        ...(await modificationEligibility(b)),
        items: await Promise.all(rows.map((m) => modificationDto(m, b))),
      };
    },
    { auth: true, params: t.Object({ code: t.String() }) },
  )
  .post(
    "/:code/modify/quote",
    async ({ params, body, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      return quoteModification(b, { ...body, children: body.children ?? 0 }, { by: "GUEST", userId: authUser.id });
    },
    { auth: true, params: t.Object({ code: t.String() }), body: t.Object(modifyInput) },
  )
  .post(
    "/:code/modify",
    async ({ params, body, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      const r = await requestModification(b.id, { ...body, children: body.children ?? 0 }, { by: "GUEST", userId: authUser.id });
      return {
        booking: await bookingDetail(r.booking, "guest"),
        modification: await modificationDto(r.modification, r.booking),
        payment: r.payment,
      };
    },
    { auth: true, params: t.Object({ code: t.String() }), body: t.Object(modifyInput) },
  )
  .post(
    "/:code/modify/:modificationId/payment",
    async ({ params, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      const mod = await db.query.bookingModifications.findFirst({
        where: and(eq(bookingModifications.id, params.modificationId), eq(bookingModifications.bookingId, b.id)),
      });
      if (!mod) throw notFound("Change request");
      return modificationPaymentOrder(b, mod);
    },
    { auth: true, params: t.Object({ code: t.String(), modificationId: uuid }) },
  )
  .post(
    "/:code/modify/:modificationId/verify-payment",
    async ({ params, body, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      const mod = await db.query.bookingModifications.findFirst({
        where: and(eq(bookingModifications.id, params.modificationId), eq(bookingModifications.bookingId, b.id)),
      });
      if (!mod?.paymentId) throw notFound("Change request");
      const [payment] = await db
        .select()
        .from(payments)
        .where(and(eq(payments.id, mod.paymentId), eq(payments.providerOrderId, body.razorpayOrderId)));
      if (!payment) throw notFound("Payment");
      if (!verifyPaymentSignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature))
        throw new AppError(400, "INVALID_SIGNATURE", "We could not verify this payment. If money was debited it will be refunded automatically.");
      const r = await confirmModificationPayment({
        orderId: body.razorpayOrderId,
        paymentId: body.razorpayPaymentId,
        verifyWithGateway: !isMockPayments(),
      });
      if (r.outcome === "REFUNDED")
        throw new AppError(
          409,
          "MODIFICATION_FAILED",
          "Sorry — the rooms were no longer available when your payment completed. The amount has been refunded.",
        );
      return { booking: await bookingDetail(r.booking, "guest"), modification: await modificationDto(r.modification, r.booking) };
    },
    {
      auth: true,
      params: t.Object({ code: t.String(), modificationId: uuid }),
      body: t.Object({
        razorpayOrderId: t.String({ minLength: 1 }),
        razorpayPaymentId: t.String({ minLength: 1 }),
        razorpaySignature: t.String({ minLength: 1 }),
      }),
    },
  )
  .delete(
    "/:code/modify/:modificationId",
    async ({ params, authUser }) => {
      const b = await ownBooking(params.code, authUser.id);
      await cancelPendingModifications(b.id, "Cancelled by guest");
      return { ok: true, modificationId: params.modificationId };
    },
    { auth: true, params: t.Object({ code: t.String(), modificationId: uuid }) },
  );
