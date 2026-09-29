import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { env } from "./config/env";
import { AppError } from "./lib/errors";
import { authModule } from "./modules/auth";
import { groupA } from "./modules/group-a";
import { groupB } from "./modules/group-b";

// Module registry — each feature module is a self-contained Elysia plugin under src/modules/<name>.
export const app = new Elysia()
  .use(
    cors({
      origin: (request) => {
        const origin = request.headers.get("origin");
        return !origin || env.corsOrigins.includes(origin);
      },
      credentials: true,
    }),
  )
  .use(openapi({ path: "/docs", documentation: { info: { title: "BookMeStays API", version: "1.0.0" } } }))
  .onError(({ code, error, set }) => {
    if (error instanceof AppError) {
      set.status = error.status;
      return { error: { code: error.code, message: error.message, details: error.details } };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: { code: "VALIDATION", message: "Some fields are invalid", details: error.all } };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: { code: "NOT_FOUND", message: "Route not found" } };
    }
    console.error(error);
    set.status = 500;
    return { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } };
  })
  .get("/health", () => ({ ok: true, time: new Date().toISOString() }))
  .use(authModule)
  .use(groupA)
  .use(groupB);

export type App = typeof app;
