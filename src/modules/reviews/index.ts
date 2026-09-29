// POST /reviews — guests review COMPLETED stays, one review per booking, held for moderation (PENDING).
import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { bookings, reviews, users } from "../../db/schema";
import { authPlugin } from "../../lib/auth";
import { conflict, notFound } from "../../lib/errors";

export const reviewsModule = new Elysia({ prefix: "/reviews", tags: ["Reviews"] }).use(authPlugin).post(
  "/",
  async ({ body, authUser }) => {
    const [b] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.code, body.bookingCode.toUpperCase()), eq(bookings.userId, authUser.id)));
    if (!b) throw notFound("Booking");
    if (b.status !== "COMPLETED") throw conflict("You can review a stay once it is completed");
    const [review] = await db
      .insert(reviews)
      .values({
        bookingId: b.id,
        userId: authUser.id,
        propertyId: b.propertyId,
        rating: body.rating,
        title: body.title?.trim() || null,
        body: body.body?.trim() || null,
        status: "PENDING",
      })
      .onConflictDoNothing({ target: reviews.bookingId })
      .returning();
    if (!review) throw conflict("You have already reviewed this stay");
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, authUser.id));
    return {
      id: review.id,
      rating: review.rating,
      title: review.title,
      body: review.body,
      authorName: u?.name || b.guestName,
      stayMonth: b.checkIn.slice(0, 7),
      partnerReply: review.partnerReply,
      createdAt: review.createdAt.toISOString(),
    };
  },
  {
    auth: true,
    body: t.Object({
      bookingCode: t.String({ minLength: 4, maxLength: 20 }),
      rating: t.Integer({ minimum: 1, maximum: 5 }),
      title: t.Optional(t.String({ maxLength: 200 })),
      body: t.Optional(t.String({ maxLength: 5000 })),
    }),
  },
);
