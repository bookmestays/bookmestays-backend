// Guest wishlist (API_CONTRACT §4).
import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { experiences, properties, wishlists } from "../../db/schema";
import { authPlugin } from "../../lib/auth";
import { notFound } from "../../lib/errors";
import { experienceCards, propertyCards } from "../../services/cards";

const itemType = t.Union([t.Literal("PROPERTY"), t.Literal("EXPERIENCE")]);

export const wishlistModule = new Elysia({ prefix: "/wishlist", tags: ["Wishlist"] })
  .use(authPlugin)
  .get(
    "/",
    async ({ authUser }) => {
      const rows = await db
        .select()
        .from(wishlists)
        .where(eq(wishlists.userId, authUser.id))
        .orderBy(desc(wishlists.createdAt));
      const ids = (type: "PROPERTY" | "EXPERIENCE") => rows.filter((r) => r.itemType === type).map((r) => r.itemId);
      const [props, exps] = await Promise.all([propertyCards(ids("PROPERTY")), experienceCards(ids("EXPERIENCE"))]);
      return { properties: props, experiences: exps };
    },
    { auth: true },
  )
  .get(
    "/ids",
    async ({ authUser }) => {
      const rows = await db
        .select({ itemType: wishlists.itemType, itemId: wishlists.itemId })
        .from(wishlists)
        .where(eq(wishlists.userId, authUser.id));
      return {
        PROPERTY: rows.filter((r) => r.itemType === "PROPERTY").map((r) => r.itemId),
        EXPERIENCE: rows.filter((r) => r.itemType === "EXPERIENCE").map((r) => r.itemId),
      };
    },
    { auth: true },
  )
  .post(
    "/",
    async ({ body, authUser }) => {
      const table = body.itemType === "PROPERTY" ? properties : experiences;
      const [exists] = await db.select({ id: table.id }).from(table).where(eq(table.id, body.itemId));
      if (!exists) throw notFound(body.itemType === "PROPERTY" ? "Property" : "Experience");
      await db
        .insert(wishlists)
        .values({ userId: authUser.id, itemType: body.itemType, itemId: body.itemId })
        .onConflictDoNothing();
      return { ok: true };
    },
    { auth: true, body: t.Object({ itemType, itemId: t.String({ format: "uuid" }) }) },
  )
  .delete(
    "/:itemType/:itemId",
    async ({ params, authUser }) => {
      await db
        .delete(wishlists)
        .where(
          and(
            eq(wishlists.userId, authUser.id),
            eq(wishlists.itemType, params.itemType),
            eq(wishlists.itemId, params.itemId),
          ),
        );
      return { ok: true };
    },
    { auth: true, params: t.Object({ itemType, itemId: t.String({ format: "uuid" }) }) },
  );
