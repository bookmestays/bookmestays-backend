// Partner: bookings (API_CONTRACT §6 Backend B). Always scoped to the caller's partner (foreign id → 404).
import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { bookings } from "../../db/schema";
import { audit } from "../../lib/audit";
import { authPlugin } from "../../lib/auth";
import { notFound } from "../../lib/errors";
import { markCheckedIn, markCheckedOut, markNoShow } from "../../services/bookings";
import { bookingDetail } from "../../services/bookings/dto";
import { listBookings } from "../../services/bookings/queries";

async function partnerBooking(id: string, partnerId: string) {
  const [b] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.partnerId, partnerId)));
  // Unpaid / abandoned checkouts are not the partner's business
  if (!b || b.status === "EXPIRED" || b.status === "PENDING_PAYMENT") throw notFound("Booking");
  return b;
}

const idParams = t.Object({ id: t.String({ format: "uuid" }) });

export const partnerBookingsModule = new Elysia({ prefix: "/partner/bookings", tags: ["Partner · Bookings"] })
  .use(authPlugin)
  .get("/", ({ query, partnerId }) => listBookings(query, { partnerId }), {
    partner: "bookings",
    query: t.Object({
      status: t.Optional(t.String()),
      propertyId: t.Optional(t.String({ format: "uuid" })),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      q: t.Optional(t.String()),
      page: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  })
  .get("/:id", async ({ params, partnerId }) => bookingDetail(await partnerBooking(params.id, partnerId), "partner"), {
    partner: "bookings",
    params: idParams,
  })
  .post(
    "/:id/check-in",
    async ({ params, partnerId, authUser }) => {
      const b = await markCheckedIn(await partnerBooking(params.id, partnerId));
      await audit(authUser, "booking.check_in", "booking", b.id);
      return bookingDetail(b, "partner");
    },
    { partner: "bookings", params: idParams },
  )
  .post(
    "/:id/check-out",
    async ({ params, partnerId, authUser }) => {
      const b = await markCheckedOut(await partnerBooking(params.id, partnerId));
      await audit(authUser, "booking.check_out", "booking", b.id);
      return bookingDetail(b, "partner");
    },
    { partner: "bookings", params: idParams },
  )
  .post(
    "/:id/no-show",
    async ({ params, partnerId, authUser }) => {
      const b = await markNoShow(await partnerBooking(params.id, partnerId));
      await audit(authUser, "booking.no_show", "booking", b.id);
      return bookingDetail(b, "partner");
    },
    { partner: "bookings", params: idParams },
  );
