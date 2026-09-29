import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";
import * as schema from "./schema";

// Disable "happy eyeballs" dual-stack racing: on slow/high-latency links its 250 ms per-address
// attempt timeout makes every connection fail with ETIMEDOUT (IPv6 has no route here).
net.setDefaultAutoSelectFamily(false);

// `prepare: false` keeps us compatible with poolers (Neon pooler / RDS Proxy / pgBouncer).
const client = postgres(env.databaseUrl, {
  prepare: false,
  max: 10,
  connect_timeout: 30,
  // Recycle connections before Neon's pooler drops them (a dropped socket used to kill the process).
  idle_timeout: 60,
  max_lifetime: 30 * 60,
  onclose: () => {},
});

export const db = drizzle(client, { schema, casing: "snake_case" });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
