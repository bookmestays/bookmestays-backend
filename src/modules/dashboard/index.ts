// GET /admin/dashboard → AdminDashboard · GET /partner/dashboard → PartnerDashboard · GET /admin/reports · GET /admin/analytics
import { Elysia, t } from "elysia";
import { ADMIN_ROLES, authPlugin } from "../../lib/auth";
import { adminDashboard, partnerDashboard } from "../../services/dashboard";
import { siteAnalytics } from "../../services/analytics";
import { adminReport } from "../../services/reports";

const dateQ = t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }));

export const dashboardModule = new Elysia({ tags: ["Dashboard"] })
  .use(authPlugin)
  .get("/admin/dashboard", () => adminDashboard(), { auth: ADMIN_ROLES })
  .get("/admin/reports", ({ query }) => adminReport(query), {
    auth: ADMIN_ROLES,
    query: t.Object({ from: dateQ, to: dateQ, groupBy: t.Optional(t.Union([t.Literal("week"), t.Literal("month")])) }),
  })
  .get("/admin/analytics", ({ query }) => siteAnalytics(query), {
    auth: ADMIN_ROLES,
    query: t.Object({ from: dateQ, to: dateQ }),
  })
  .get("/partner/dashboard", ({ partnerId }) => partnerDashboard(partnerId), { partner: true });
