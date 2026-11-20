import { Elysia } from "elysia";
import { adminModule } from "./admin";
import { blogModule } from "./blog";
import { mediaModule } from "./media";
import { partnerModule } from "./partner";
import { publicModule } from "./public";

// Backend workstream A: media, public catalog, admin catalog/CMS, partner catalog, blog.
// Register each module here with .use(...)
export const groupA = new Elysia({ name: "group-a" })
  .use(mediaModule)
  .use(publicModule)
  .use(adminModule)
  .use(partnerModule)
  .use(blogModule);
