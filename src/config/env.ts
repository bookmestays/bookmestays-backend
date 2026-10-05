// Central, typed access to environment variables. Bun loads .env automatically.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

const channelManager = (prefix: string) => ({
  inboundUsername: optional(`CM_${prefix}_USERNAME`),
  inboundPassword: optional(`CM_${prefix}_PASSWORD`),
  endpoint: optional(`CM_${prefix}_ENDPOINT`),
  apiKey: optional(`CM_${prefix}_API_KEY`),
});

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProd: process.env.NODE_ENV === "production",
  port: Number(optional("PORT", "4000")),
  apiUrl: optional("API_URL", "http://localhost:4000"),
  webUrl: optional("WEB_URL", "http://localhost:3000"),
  corsOrigins: optional("CORS_ORIGINS", "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: required("DATABASE_URL"),

  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  accessTokenTtl: optional("ACCESS_TOKEN_TTL", "15m"),
  refreshTokenTtlDays: Number(optional("REFRESH_TOKEN_TTL_DAYS", "30")),
  encryptionKey: required("ENCRYPTION_KEY"),
  seedAdminEmail: optional("SEED_ADMIN_EMAIL", "admin@bookmestays.com"),
  seedAdminPassword: optional("SEED_ADMIN_PASSWORD", "ChangeMe@123"),

  aws: {
    region: optional("AWS_REGION", "ap-south-1"),
    accessKeyId: optional("AWS_ACCESS_KEY_ID"),
    secretAccessKey: optional("AWS_SECRET_ACCESS_KEY"),
    bucket: optional("S3_BUCKET"),
    mediaCdnUrl: optional("MEDIA_CDN_URL"),
  },

  razorpay: {
    keyId: optional("RAZORPAY_KEY_ID"),
    keySecret: optional("RAZORPAY_KEY_SECRET"),
    webhookSecret: optional("RAZORPAY_WEBHOOK_SECRET"),
    xAccountNumber: optional("RAZORPAYX_ACCOUNT_NUMBER"),
    routeEnabled: optional("RAZORPAY_ROUTE_ENABLED", "true") === "true",
  },

  email: {
    provider: optional("EMAIL_PROVIDER", "console"),
    smtpHost: optional("SMTP_HOST"),
    smtpPort: Number(optional("SMTP_PORT", "587")),
    smtpUser: optional("SMTP_USER"),
    smtpPass: optional("SMTP_PASS"),
    from: optional("EMAIL_FROM", "BookMeStays <no-reply@bookmestays.com>"),
  },

  channelManagers: {
    channelCode: optional("CM_CHANNEL_CODE", "BOOKMESTAYS"),
    AXISROOMS: channelManager("AXISROOMS"),
    EZEE: channelManager("EZEE"),
    STAAH: channelManager("STAAH"),
    SITEMINDER: channelManager("SITEMINDER"),
  },
};

export type ChannelManagerProvider = "AXISROOMS" | "EZEE" | "STAAH" | "SITEMINDER";
