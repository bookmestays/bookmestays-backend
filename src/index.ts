import { app } from "./app";
import { env } from "./config/env";
import { startJobs } from "./jobs";

// A dropped database/gateway socket must never take the API down: log it and keep serving.
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

// 600 MB body limit so local-dev video uploads (≤ 500 MB) fit; production uploads go straight to S3.
app.listen({ port: env.port, maxRequestBodySize: 600 * 1024 * 1024 });
startJobs();

console.log(`🦊 BookMeStays API running at http://localhost:${env.port} (docs: /docs)`);
