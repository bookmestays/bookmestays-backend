import { Elysia } from "elysia";
import { availabilityModule } from "./availability";
import { guestBookingsModule } from "./bookings";
import { adminBookingsModule } from "./bookings/admin";
import { partnerBookingsModule } from "./bookings/partner";
import { adminChannelModule, channelInboundModule, partnerChannelModule } from "./channel";
import { dashboardModule } from "./dashboard";
import { razorpayWebhookModule } from "./payments/webhook";
import { reviewsModule } from "./reviews";
import { settlementsModule } from "./settlements";
import { wishlistModule } from "./wishlist";

// Backend workstream B: availability, bookings, payments, settlements, dashboards, channel managers.
export const groupB = new Elysia({ name: "group-b" })
  .use(availabilityModule)
  .use(guestBookingsModule)
  .use(reviewsModule)
  .use(wishlistModule)
  .use(razorpayWebhookModule)
  .use(dashboardModule)
  .use(adminBookingsModule)
  .use(partnerBookingsModule)
  .use(settlementsModule)
  .use(channelInboundModule)
  .use(adminChannelModule)
  .use(partnerChannelModule);
