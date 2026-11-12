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
  refreshTokenTtlDays: Number(optional("REFRESH_TOKEN_TTL_DAYS", "365")),
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

  // WhatsApp (AiSensy). provider: console | aisensy  (console just logs, useful in development).
  // Each `campaign` maps to an API Campaign you create in the AiSensy dashboard, linked to an
  // approved WhatsApp template. The campaign name here MUST match the name in AiSensy exactly.
  whatsapp: {
    provider: optional("WHATSAPP_PROVIDER", "console"),
    apiKey: optional("AISENSY_API_KEY"), // Manage → API Key in the AiSensy dashboard (a long JWT)
    apiUrl: optional("AISENSY_API_URL", "https://backend.aisensy.com/campaign/t1/api/v2"),
    senderName: optional("AISENSY_SENDER_NAME", "BookMeStays"),
    // Authentication templates carry a copy-code button; set false if your OTP template has none.
    otpCopyCodeButton: optional("AISENSY_OTP_COPY_CODE_BUTTON", "true") === "true",
    // WhatsApp numbers that receive an internal alert on every new booking.
    adminNumbers: optional("ADMIN_WHATSAPP_NUMBERS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    campaigns: {
      otp: optional("AISENSY_CAMPAIGN_OTP"), // authentication template, body param {{1}} = the code
      bookingGuest: optional("AISENSY_CAMPAIGN_BOOKING_GUEST"), // utility template → guest
      bookingPartner: optional("AISENSY_CAMPAIGN_BOOKING_PARTNER"), // utility template → partner
      bookingAdmin: optional("AISENSY_CAMPAIGN_BOOKING_ADMIN"), // utility template → admin ops
      bookingCancelledGuest: optional("AISENSY_CAMPAIGN_BOOKING_CANCELLED_GUEST"),
      bookingCancelledPartner: optional("AISENSY_CAMPAIGN_BOOKING_CANCELLED_PARTNER"),
    },
  },

  channelManagers: {
    channelCode: optional("CM_CHANNEL_CODE", "BOOKMESTAYS"),
    AXISROOMS: channelManager("AXISROOMS"),
    EZEE: channelManager("EZEE"),
    STAAH: channelManager("STAAH"),
    SITEMINDER: channelManager("SITEMINDER"),
    ASIATECH: channelManager("ASIATECH"),
  },
};

export type ChannelManagerProvider = "AXISROOMS" | "EZEE" | "STAAH" | "SITEMINDER" | "ASIATECH";
