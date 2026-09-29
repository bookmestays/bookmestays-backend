// Provider adapters. Each extends the generic OTA adapter; the marked QUIRKS sections are where
// provider-specific behaviour goes once we have that CM's partner/certification documentation.
// Nothing below is invented provider API detail — defaults are the plain OTA behaviour.
import { env } from "../../config/env";
import { OtaChannelAdapter } from "./ota";
import type { ChannelAdapter, OutboundMessage, Provider, ReservationPayload } from "./types";

/** AxisRooms (India) — OTA XML channel connectivity. */
class AxisRoomsAdapter extends OtaChannelAdapter {
  constructor() {
    super("AXISROOMS", "AxisRooms", "axisrooms");
  }
  // QUIRKS (fill in from AxisRooms channel-partner docs):
  //  • Outbound auth: confirm whether they want HTTP Basic, an API key header or credentials in <POS>.
  //  • Confirm whether cancellations must be sent as OTA_CancelRQ instead of ResStatus="Cancel".
  //  • Confirm date-range limits per message and whether they send BookingLimit or InvCountNotif for inventory.
}

/** eZee Centrix (Yanolja Cloud Solution) — channel manager. */
class EzeeAdapter extends OtaChannelAdapter {
  constructor() {
    super("EZEE", "eZee Centrix", "ezee");
  }
  // QUIRKS (fill in from eZee Centrix connectivity docs):
  //  • eZee also offers its own (non-OTA) XML/JSON interfaces with a per-hotel "HotelCode" + "AuthCode";
  //    if they route us through that interface, override parseInbound / buildReservationMessage here.
  //  • Per-hotel auth codes can be stored encrypted in channel_connections.credentials_enc.
}

/** STAAH — Channel Manager / MAX. */
class StaahAdapter extends OtaChannelAdapter {
  constructor() {
    super("STAAH", "STAAH", "staah");
  }
  // QUIRKS (fill in from STAAH connectivity docs):
  //  • Confirm whether STAAH pulls reservations (OTA_ReadRQ + OTA_NotifReportRQ) or wants pushes, or both.
  //  • Confirm which occupancy-based amounts (BaseByGuestAmt NumberOfGuests) they send for rates.
}

/** SiteMinder — pmsXchange / channel connectivity (SOAP-wrapped OTA with WS-Security). */
class SiteMinderAdapter extends OtaChannelAdapter {
  constructor() {
    super("SITEMINDER", "SiteMinder", "siteminder");
  }
  // QUIRKS: SiteMinder's interfaces are SOAP 1.1 envelopes around OTA messages, authenticated with a
  // WS-Security UsernameToken. Inbound SOAP is already unwrapped by the base parser (and responses are
  // wrapped back when the request was SOAP). Outbound messages are wrapped here. Exact SOAPAction values,
  // endpoint and certification scenarios come from SiteMinder's partner programme.
  override buildReservationMessage(r: ReservationPayload): OutboundMessage {
    const plain = super.buildReservationMessage(r);
    const inner = plain.body.replace(/^<\?xml[^>]*>\s*/, "");
    const username = env.channelManagers.channelCode;
    const password = this.config.apiKey;
    const header = password
      ? `<soap:Header><wsse:Security soap:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken><wsse:Username>${escapeXml(username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(password)}</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header>`
      : "";
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">${header}<soap:Body>${inner}</soap:Body></soap:Envelope>`;
    return { ...plain, body };
  }
  protected override outboundHeaders(): Record<string, string> {
    return {}; // credentials travel in the WS-Security header
  }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const ADAPTERS: Record<Provider, ChannelAdapter> = {
  AXISROOMS: new AxisRoomsAdapter(),
  EZEE: new EzeeAdapter(),
  STAAH: new StaahAdapter(),
  SITEMINDER: new SiteMinderAdapter(),
};

export const PROVIDERS = Object.keys(ADAPTERS) as Provider[];
export const adapterBySlug = (slug: string) => Object.values(ADAPTERS).find((a) => a.slug === slug.toLowerCase());

export function providerInfo(p: Provider) {
  const a = ADAPTERS[p];
  const cfg = env.channelManagers[p];
  return {
    provider: p,
    label: a.label,
    inboundConfigured: Boolean(cfg.inboundUsername && cfg.inboundPassword),
    outboundConfigured: Boolean(cfg.endpoint),
    inboundEndpoint: `${env.apiUrl.replace(/\/$/, "")}/channel/${a.slug}/ota`,
  };
}
