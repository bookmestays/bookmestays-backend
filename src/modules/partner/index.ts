import { Elysia } from "elysia";
import { partnerCalendar } from "./calendar";
import { partnerProperties } from "./properties";
import { partnerRooms } from "./rooms";
import { partnerTeam } from "./team";

// Partner catalog (Backend A). Every route is scoped to the caller's partnerId (foreign ids → 404).
export const partnerModule = new Elysia({ prefix: "/partner", tags: ["Partner"] })
  .use(partnerProperties)
  .use(partnerRooms)
  .use(partnerCalendar)
  .use(partnerTeam);
