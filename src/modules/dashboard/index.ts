// GET /admin/dashboard → AdminDashboard · GET /partner/dashboard → PartnerDashboard
import { Elysia } from "elysia";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { adminDashboard, partnerDashboard } from "../../services/dashboard";

export const dashboardModule = new Elysia({ tags: ["Dashboard"] })
  .use(authPlugin)
  .get("/admin/dashboard", () => adminDashboard(), { auth: ADMIN_ROLES })
  .get("/partner/dashboard", ({ partnerId }) => partnerDashboard(partnerId), { partner: true });
