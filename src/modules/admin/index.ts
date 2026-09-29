import { Elysia } from "elysia";
import { adminCms } from "./cms";
import { adminGeo } from "./geo";
import { adminOps } from "./ops";
import { adminPartners } from "./partners";
import { adminProperties } from "./properties";
import { adminRooms } from "./rooms";

// Admin catalog / CMS (Backend A). All routes require SUPER_ADMIN or ADMIN_STAFF.
export const adminModule = new Elysia({ prefix: "/admin", tags: ["Admin"] })
  .use(adminPartners)
  .use(adminProperties)
  .use(adminRooms)
  .use(adminGeo)
  .use(adminCms)
  .use(adminOps);
