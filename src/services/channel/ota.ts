// Generic OpenTravel Alliance (OTA 2015B-style) channel adapter.
//
// HONESTY NOTE: AxisRooms, eZee Centrix, STAAH and SiteMinder each publish their exact connectivity spec
// (element subsets, auth style, endpoint URLs, certification test cases) only to partners under their
// connectivity / certification programme. What is implemented here is the OTA standard message set these
// channel managers commonly speak (AvailNotif / RateAmountNotif / InvCountNotif / ReadRQ / NotifReport /
// HotelResNotif). Provider-specific differences go into the subclasses in ./providers.ts once we receive
// each CM's documentation, and every provider must certify the integration before going live.
import { timingSafeEqual } from "node:crypto";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { env } from "../../config/env";
import { addDays } from "../../lib/utils";
import {
  OTA_ERR,
  OtaError,
  type AriUpdate,
  type ChannelAdapter,
  type InboundRequest,
  type InboundResult,
  type OutboundMessage,
  type Provider,
  type PushResult,
  type ReservationPayload,
  type ResponseContext,
  type WireFormat,
} from "./types";

export const OTA_NS = "http://www.opentravel.org/OTA/2003/05";

type Node = Record<string, any>;

const ARRAY_TAGS = new Set([
  "AvailStatusMessage",
  "RateAmountMessage",
  "Inventory",
  "InvCount",
  "Rate",
  "BaseByGuestAmt",
  "LengthOfStay",
  "RestrictionStatus",
  "HotelReadRequest",
  "HotelReservation",
  "HotelReservationID",
  "UniqueID",
  "Error",
]);

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

export const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  format: true,
  suppressEmptyNode: true,
});

export const arr = <T = Node>(x: unknown): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]) as T[];
export const attr = (n: Node | undefined, name: string): string | undefined => {
  const v = n?.[`@_${name}`];
  return v == null || v === "" ? undefined : String(v);
};
const text = (v: unknown): string | undefined =>
  v == null ? undefined : typeof v === "object" ? ((v as Node)["#text"] as string | undefined) : String(v);
const bool = (v: string | undefined) => (v == null ? undefined : v === "1" || v.toLowerCase() === "true");
const int = (v: string | undefined) => (v == null || !/^-?\d+$/.test(v.trim()) ? undefined : Number(v));
const rupees = (paise: number) => (paise / 100).toFixed(2);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function otaDate(v: string | undefined, ctx: ResponseContext, field: string): string {
  const d = v?.slice(0, 10);
  if (!d || !DATE_RE.test(d) || Number.isNaN(Date.parse(d)))
    throw new OtaError(OTA_ERR.DATE[0], `Invalid or missing ${field}`, OTA_ERR.DATE[2], ctx);
  return d;
}

/** Converts an OTA amount to paise, honouring DecimalPlaces (e.g. Amount="450000" DecimalPlaces="2"). */
function otaAmount(value: string | undefined, decimalPlaces?: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const dp = int(decimalPlaces);
  const inRupees = dp != null && !value.includes(".") ? n / 10 ** dp : n;
  return Math.round(inRupees * 100);
}

const DAY_ATTRS: [string, number][] = [
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Weds", 3],
  ["Thur", 4],
  ["Fri", 5],
  ["Sat", 6],
];

export class OtaChannelAdapter implements ChannelAdapter {
  constructor(
    readonly provider: Provider,
    readonly label: string,
    readonly slug: string,
  ) {}

  protected get config() {
    return env.channelManagers[this.provider];
  }

  // ─── Inbound: parsing ──────────────────────────────────────────────────────

  parseInbound(body: string, format: WireFormat): InboundRequest {
    return format === "json" ? this.parseJson(body) : this.parseXml(body);
  }

  /** Returns the OTA root element, unwrapping a SOAP envelope (and reading WS-Security credentials) if present. */
  protected unwrap(body: string): { name: string; root: Node; soap: boolean; credentials?: { username?: string; password?: string } } {
    let doc: Node;
    try {
      doc = xmlParser.parse(body, true) as Node;
    } catch (err) {
      throw new OtaError(OTA_ERR.FORMAT[0], `Malformed XML: ${(err as Error).message}`.slice(0, 300), OTA_ERR.FORMAT[2]);
    }
    const first = (n: Node) => Object.keys(n).find((k) => !k.startsWith("?") && !k.startsWith("@_") && k !== "#text");
    let name = first(doc);
    if (!name) throw new OtaError(OTA_ERR.FORMAT[0], "Empty XML document", OTA_ERR.FORMAT[2]);
    let root = doc[name] as Node;
    if (name === "Envelope") {
      const token = root.Header?.Security?.UsernameToken as Node | undefined;
      const inner = (root.Body ?? {}) as Node;
      name = first(inner);
      if (!name) throw new OtaError(OTA_ERR.FORMAT[0], "Empty SOAP body", OTA_ERR.FORMAT[2]);
      root = (inner[name] ?? {}) as Node;
      return {
        name,
        root,
        soap: true,
        credentials: token ? { username: text(token.Username), password: text(token.Password) } : undefined,
      };
    }
    return { name, root: typeof root === "object" ? root : {}, soap: false };
  }

  protected parseXml(body: string): InboundRequest {
    const { name, root, soap, credentials: wsse } = this.unwrap(body);
    const ctx: ResponseContext = { messageType: name, echoToken: attr(root, "EchoToken"), soap };
    const requestor = arr(arr(root.POS?.Source)[0]?.RequestorID)[0];
    const credentials = wsse ?? (requestor ? { username: attr(requestor, "ID"), password: attr(requestor, "MessagePassword") } : undefined);
    const env = { messageType: name, echoToken: ctx.echoToken, soap, credentials };

    switch (name) {
      case "OTA_HotelAvailNotifRQ": {
        const msgs = root.AvailStatusMessages ?? {};
        const updates = arr(msgs.AvailStatusMessage).map((m) => {
          const u = this.sacToUpdate(m.StatusApplicationControl, ctx);
          const limit = int(attr(m, "BookingLimit"));
          if (limit != null) u.inventory = Math.max(0, limit);
          for (const los of arr(m.LengthsOfStay?.LengthOfStay)) {
            const type = attr(los, "MinMaxMessageType") ?? "";
            const time = int(attr(los, "Time"));
            if (time == null) continue;
            if (/Min/i.test(type)) u.minStay = Math.max(1, time);
            else if (/Max/i.test(type)) u.maxStay = time > 0 ? time : null;
          }
          for (const rs of arr(m.RestrictionStatus)) {
            const status = attr(rs, "Status");
            if (!status) continue;
            const closed = status.toLowerCase() === "close";
            const restriction = (attr(rs, "Restriction") ?? "Master").toLowerCase();
            if (restriction === "arrival") u.closedToArrival = closed;
            else if (restriction === "departure") u.closedToDeparture = closed;
            else u.stopSell = closed;
          }
          return u;
        });
        return { ...env, kind: "ARI", hotelCode: this.hotelCode(msgs, root, ctx), updates };
      }

      case "OTA_HotelRateAmountNotifRQ": {
        const msgs = root.RateAmountMessages ?? {};
        const updates: AriUpdate[] = [];
        for (const m of arr(msgs.RateAmountMessage)) {
          const base = this.sacToUpdate(m.StatusApplicationControl, ctx);
          if (!base.rateCode)
            throw new OtaError(OTA_ERR.REQUIRED[0], "RatePlanCode is required for rate updates", OTA_ERR.REQUIRED[2], ctx);
          for (const rate of arr(m.Rates?.Rate)) {
            const u: AriUpdate = { ...base };
            if (attr(rate, "Start")) u.start = otaDate(attr(rate, "Start"), ctx, "Rate Start");
            if (attr(rate, "End")) u.end = otaDate(attr(rate, "End"), ctx, "Rate End");
            const days = this.daysOf(rate);
            if (days) u.days = days;
            const amounts = arr(rate.BaseByGuestAmts?.BaseByGuestAmt);
            const pick =
              amounts.find((a) => attr(a, "NumberOfGuests") === "2") ??
              [...amounts]
                .filter((a) => (int(attr(a, "NumberOfGuests")) ?? 0) <= 2)
                .sort((a, b) => (int(attr(b, "NumberOfGuests")) ?? 0) - (int(attr(a, "NumberOfGuests")) ?? 0))[0] ??
              amounts[0];
            // Our rates are the hotel tariff before GST (GST is added at checkout). Prefer AmountBeforeTax;
            // most CMs only send AmountAfterTax, which in practice carries the tariff they manage.
            const price = otaAmount(
              attr(pick, "AmountBeforeTax") ?? attr(pick, "AmountAfterTax"),
              attr(pick, "DecimalPlaces") ?? attr(rate, "DecimalPlaces"),
            );
            if (price == null)
              throw new OtaError(OTA_ERR.REQUIRED[0], "BaseByGuestAmt amount is missing or invalid", OTA_ERR.REQUIRED[2], ctx);
            u.price = price;
            updates.push(u);
          }
        }
        return { ...env, kind: "ARI", hotelCode: this.hotelCode(msgs, root, ctx), updates };
      }

      case "OTA_HotelInvCountNotifRQ": {
        const inv = root.Inventories ?? {};
        const updates = arr(inv.Inventory).map((i) => {
          const u = this.sacToUpdate(i.StatusApplicationControl, ctx);
          const counts = arr(i.InvCounts?.InvCount);
          const c = counts.find((x) => attr(x, "CountType") === "2") ?? counts[0];
          const count = int(attr(c, "Count"));
          if (count == null) throw new OtaError(OTA_ERR.REQUIRED[0], "InvCount Count is required", OTA_ERR.REQUIRED[2], ctx);
          u.inventory = Math.max(0, count);
          u.rateCode = null; // inventory is per room type
          return u;
        });
        return { ...env, kind: "ARI", hotelCode: this.hotelCode(inv, root, ctx), updates };
      }

      case "OTA_ReadRQ": {
        const req = arr(root.ReadRequests?.HotelReadRequest)[0];
        return { ...env, kind: "READ", hotelCode: this.hotelCode(req, root, ctx) };
      }

      case "OTA_NotifReportRQ": {
        const reports = root.NotifDetails?.HotelNotifReport ?? {};
        const holder = reports.HotelReservations ?? {};
        const reservations = arr(holder.HotelReservation);
        const success = root.Success !== undefined && root.Errors === undefined;
        const acks = success
          ? reservations
              .map((r) => {
                const ids = arr(r.UniqueID);
                const ours = ids.find((u) => attr(u, "Type") === "14") ?? ids[0];
                const pms = arr(r.ResGlobalInfo?.HotelReservationIDs?.HotelReservationID).find(
                  (h) => attr(h, "ResID_Type") === "10" || attr(h, "ResID_Type") === "14",
                );
                return { bookingCode: attr(ours, "ID") ?? "", cmReference: attr(pms, "ResID_Value") ?? null };
              })
              .filter((a) => a.bookingCode)
          : [];
        const hotelCode =
          attr(holder, "HotelCode") ??
          attr(reservations[0]?.RoomStays?.RoomStay?.BasicPropertyInfo, "HotelCode") ??
          attr(reservations[0]?.BasicPropertyInfo, "HotelCode") ??
          attr(root, "HotelCode") ??
          null;
        return { ...env, kind: "ACK", hotelCode, acks };
      }

      default:
        throw new OtaError(OTA_ERR.UNSUPPORTED[0], `Message type ${name} is not supported`, OTA_ERR.UNSUPPORTED[2], ctx);
    }
  }

  protected hotelCode(n: Node | undefined, root: Node, ctx: ResponseContext): string {
    const code = attr(n, "HotelCode") ?? attr(root, "HotelCode");
    if (!code) throw new OtaError(OTA_ERR.REQUIRED[0], "HotelCode is required", OTA_ERR.REQUIRED[2], ctx);
    return code;
  }

  protected daysOf(n: Node | undefined): number[] | null {
    const present = DAY_ATTRS.filter(([a]) => attr(n, a) != null);
    if (!present.length) return null;
    return present.filter(([a]) => bool(attr(n, a))).map(([, d]) => d);
  }

  protected sacToUpdate(sac: Node | undefined, ctx: ResponseContext): AriUpdate {
    if (!sac) throw new OtaError(OTA_ERR.REQUIRED[0], "StatusApplicationControl is required", OTA_ERR.REQUIRED[2], ctx);
    const roomCode = attr(sac, "InvTypeCode") ?? attr(sac, "InvCode");
    if (!roomCode) throw new OtaError(OTA_ERR.REQUIRED[0], "InvTypeCode is required", OTA_ERR.REQUIRED[2], ctx);
    const start = otaDate(attr(sac, "Start"), ctx, "Start");
    const end = otaDate(attr(sac, "End"), ctx, "End");
    if (end < start) throw new OtaError(OTA_ERR.DATE[0], "End must not be before Start", OTA_ERR.DATE[2], ctx);
    return { roomCode, rateCode: attr(sac, "RatePlanCode") ?? null, start, end, days: this.daysOf(sac) };
  }

  /**
   * JSON variant for CMs that prefer JSON:
   *   { hotelCode, type: "ari", updates: [{ roomCode, rateCode?, start, end, days?, inventory?, price (paise)?,
   *     minStay?, maxStay?, closedToArrival?, closedToDeparture?, stopSell? }] }
   *   { hotelCode, type: "reservations_pull" }
   *   { hotelCode, type: "reservations_ack", bookingCodes: [...] }
   */
  protected parseJson(body: string): InboundRequest {
    let j: Node;
    try {
      j = JSON.parse(body) as Node;
    } catch {
      throw new OtaError(OTA_ERR.FORMAT[0], "Malformed JSON", OTA_ERR.FORMAT[2]);
    }
    const type = String(j.type ?? "");
    const ctx: ResponseContext = { messageType: type || null };
    const credentials = j.username ? { username: String(j.username), password: String(j.password ?? "") } : undefined;
    const base = { messageType: `json:${type}`, credentials, echoToken: j.requestId ? String(j.requestId) : undefined };
    const hotelCode = j.hotelCode ? String(j.hotelCode) : "";
    if (type === "ari") {
      if (!hotelCode) throw new OtaError(OTA_ERR.REQUIRED[0], "hotelCode is required", OTA_ERR.REQUIRED[2], ctx);
      const updates = arr(j.updates).map((u): AriUpdate => {
        if (!u.roomCode) throw new OtaError(OTA_ERR.REQUIRED[0], "roomCode is required", OTA_ERR.REQUIRED[2], ctx);
        const start = otaDate(u.start, ctx, "start");
        const end = otaDate(u.end ?? u.start, ctx, "end");
        if (end < start) throw new OtaError(OTA_ERR.DATE[0], "end must not be before start", OTA_ERR.DATE[2], ctx);
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
        return {
          roomCode: String(u.roomCode),
          rateCode: u.rateCode ? String(u.rateCode) : null,
          start,
          end,
          days: Array.isArray(u.days) ? u.days.map(Number) : null,
          inventory: num(u.inventory),
          price: num(u.price) != null ? Math.round(u.price) : undefined,
          minStay: num(u.minStay),
          maxStay: u.maxStay === null ? null : num(u.maxStay),
          closedToArrival: flag(u.closedToArrival),
          closedToDeparture: flag(u.closedToDeparture),
          stopSell: flag(u.stopSell),
        };
      });
      return { ...base, kind: "ARI", hotelCode, updates };
    }
    if (type === "reservations_pull") {
      if (!hotelCode) throw new OtaError(OTA_ERR.REQUIRED[0], "hotelCode is required", OTA_ERR.REQUIRED[2], ctx);
      return { ...base, kind: "READ", hotelCode };
    }
    if (type === "reservations_ack")
      return {
        ...base,
        kind: "ACK",
        hotelCode: hotelCode || null,
        acks: arr<string>(j.bookingCodes).map((c) => ({ bookingCode: String(c), cmReference: null })),
      };
    throw new OtaError(OTA_ERR.UNSUPPORTED[0], `Unsupported type "${type}"`, OTA_ERR.UNSUPPORTED[2], ctx);
  }

  // ─── Inbound: auth ─────────────────────────────────────────────────────────

  authenticateInbound(headers: Record<string, string | undefined>, req: InboundRequest | null): boolean {
    const { inboundUsername, inboundPassword } = this.config;
    // Credentials not configured yet: open in development, closed in production.
    if (!inboundUsername || !inboundPassword) return !env.isProd;
    const creds = this.basicAuth(headers) ?? req?.credentials;
    if (!creds?.username || creds.password == null) return false;
    return safeEqual(creds.username, inboundUsername) && safeEqual(creds.password, inboundPassword);
  }

  protected basicAuth(headers: Record<string, string | undefined>) {
    const h = headers.authorization;
    if (!h?.startsWith("Basic ")) return undefined;
    const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    return i < 0 ? undefined : { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
  }

  // ─── Inbound: responses ────────────────────────────────────────────────────

  protected responseName(messageType: string | null) {
    if (messageType === "OTA_ReadRQ") return "OTA_ResRetrieveRS";
    if (messageType?.endsWith("RQ")) return messageType.replace(/RQ$/, "RS");
    return "OTA_ErrorRS";
  }

  formatResponse(ctx: ResponseContext, result: InboundResult, format: WireFormat) {
    if (format === "json") {
      const body = result.ok
        ? {
            success: true,
            ...(result.kind === "ARI" ? { applied: result.applied } : {}),
            ...(result.kind === "ACK" ? { acknowledged: result.acked } : {}),
            ...(result.kind === "READ" ? { reservations: result.reservations } : {}),
          }
        : { success: false, errors: result.errors };
      return { body: JSON.stringify(body), contentType: "application/json" };
    }
    const content: Node = {
      "@_xmlns": OTA_NS,
      ...(ctx.echoToken ? { "@_EchoToken": ctx.echoToken } : {}),
      "@_TimeStamp": new Date().toISOString(),
      "@_Version": "1.0",
    };
    if (result.ok) {
      content.Success = "";
      if (result.kind === "READ")
        content.ReservationsList = { HotelReservation: result.reservations.map((r) => this.hotelReservationNode(r)) };
    } else {
      content.Errors = {
        Error: result.errors.map((e) => ({ "@_Type": e.type ?? "3", "@_Code": e.code, "#text": e.message })),
      };
    }
    const doc = { [this.responseName(ctx.messageType)]: content };
    return { body: this.serialize(doc, ctx.soap ?? false), contentType: "text/xml; charset=utf-8" };
  }

  protected serialize(doc: Node, soap: boolean, soapHeader?: Node): string {
    const payload = soap
      ? {
          "soap:Envelope": {
            "@_xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/",
            ...(soapHeader ? { "soap:Header": soapHeader } : {}),
            "soap:Body": doc,
          },
        }
      : doc;
    return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBuilder.build(payload)}`;
  }

  // ─── Outbound: reservations ────────────────────────────────────────────────

  protected resStatus(kind: ReservationPayload["kind"]) {
    return kind === "CANCEL" ? "Cancel" : kind === "MODIFY" ? "Modify" : "Commit";
  }

  /** <HotelReservation> used both in OTA_HotelResNotifRQ (push) and OTA_ResRetrieveRS (pull). */
  protected hotelReservationNode(r: ReservationPayload): Node {
    const channel = env.channelManagers.channelCode;
    const [given, ...rest] = r.guest.name.trim().split(/\s+/);
    return {
      "@_CreateDateTime": r.createdAt,
      "@_LastModifyDateTime": r.updatedAt,
      "@_ResStatus": this.resStatus(r.kind),
      UniqueID: [{ "@_Type": "14", "@_ID": r.code, "@_ID_Context": channel }],
      RoomStays: {
        RoomStay: r.rooms.map((room) => ({
          RoomTypes: { RoomType: { "@_RoomTypeCode": room.cmRoomCode, "@_NumberOfUnits": room.quantity } },
          RatePlans: { RatePlan: { "@_RatePlanCode": room.cmRateCode ?? "" } },
          RoomRates: {
            RoomRate: {
              "@_RoomTypeCode": room.cmRoomCode,
              "@_RatePlanCode": room.cmRateCode ?? "",
              "@_NumberOfUnits": room.quantity,
              Rates: {
                Rate: room.nightly.map((n) => ({
                  "@_EffectiveDate": n.date,
                  "@_ExpireDate": addDays(n.date, 1),
                  "@_RateTimeUnit": "Day",
                  "@_UnitMultiplier": 1,
                  Base: { "@_AmountBeforeTax": rupees(n.price), "@_CurrencyCode": r.currency },
                })),
              },
            },
          },
          GuestCounts: {
            GuestCount: [
              { "@_AgeQualifyingCode": "10", "@_Count": room.adults },
              ...(room.children ? [{ "@_AgeQualifyingCode": "8", "@_Count": room.children }] : []),
            ],
          },
          TimeSpan: { "@_Start": r.checkIn, "@_End": r.checkOut },
          Total: { "@_AmountBeforeTax": rupees(room.amount), "@_CurrencyCode": r.currency },
          BasicPropertyInfo: { "@_HotelCode": r.hotelCode },
          ResGuestRPHs: { ResGuestRPH: { "@_RPH": "1" } },
        })),
      },
      ResGuests: {
        ResGuest: {
          "@_ResGuestRPH": "1",
          "@_PrimaryIndicator": "true",
          Profiles: {
            ProfileInfo: {
              Profile: {
                "@_ProfileType": "1",
                Customer: {
                  PersonName: { GivenName: given ?? r.guest.name, Surname: rest.join(" ") || given || r.guest.name },
                  Telephone: { "@_PhoneNumber": r.guest.phone },
                  Email: r.guest.email,
                },
              },
            },
          },
        },
      },
      ResGlobalInfo: {
        ...(r.specialRequests ? { Comments: { Comment: { Text: r.specialRequests } } } : {}),
        Guarantee: {
          "@_GuaranteeType": "PrePay",
          GuaranteeDescription: { Text: `Prepaid online via ${channel}. Do not charge the guest for the room.` },
        },
        Total: {
          "@_AmountBeforeTax": rupees(r.roomAmount),
          "@_AmountAfterTax": rupees(r.roomAmount + r.roomTax),
          "@_CurrencyCode": r.currency,
          Taxes: { Tax: { "@_Amount": rupees(r.roomTax), "@_CurrencyCode": r.currency } },
        },
        HotelReservationIDs: {
          HotelReservationID: [{ "@_ResID_Type": "14", "@_ResID_Value": r.code, "@_ResID_Source": channel }],
        },
        BasicPropertyInfo: { "@_HotelCode": r.hotelCode },
      },
    };
  }

  buildReservationMessage(r: ReservationPayload): OutboundMessage {
    const channel = env.channelManagers.channelCode;
    const doc = {
      OTA_HotelResNotifRQ: {
        "@_xmlns": OTA_NS,
        "@_EchoToken": `${r.code}-${Date.now()}`,
        "@_TimeStamp": new Date().toISOString(),
        "@_Version": "1.0",
        "@_ResStatus": this.resStatus(r.kind),
        POS: {
          Source: {
            RequestorID: { "@_Type": "22", "@_ID": channel },
            BookingChannel: { "@_Type": "7", CompanyName: { "@_Code": channel, "#text": "BookMeStays" } },
          },
        },
        HotelReservations: { HotelReservation: [this.hotelReservationNode(r)] },
      },
    };
    return { body: this.serialize(doc, false), contentType: "text/xml; charset=utf-8", messageType: "OTA_HotelResNotifRQ" };
  }

  /** Auth headers for pushes to the CM. Default: HTTP Basic <channelCode>:<CM_<P>_API_KEY>. */
  protected outboundHeaders(): Record<string, string> {
    const key = this.config.apiKey;
    if (!key) return {};
    const basic = Buffer.from(`${env.channelManagers.channelCode}:${key}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }

  /** Decides if the CM accepted the message. OTA: HTTP 2xx + <Success/> and no <Errors>. */
  protected isAccepted(status: number, body: string): { ok: boolean; error?: string } {
    if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` };
    try {
      const doc = xmlParser.parse(body) as Node;
      const flat = JSON.stringify(doc);
      if (flat.includes('"Errors"')) {
        const errs = this.findErrors(doc);
        return { ok: false, error: errs || "CM returned Errors" };
      }
      if (flat.includes('"Success"')) return { ok: true };
      return { ok: false, error: "No <Success/> in response" };
    } catch {
      return { ok: false, error: "Unparseable response" };
    }
  }

  private findErrors(n: unknown): string {
    if (!n || typeof n !== "object") return "";
    const node = n as Node;
    if (node.Errors)
      return arr(node.Errors.Error)
        .map((e) => `${attr(e, "Code") ?? ""} ${text(e) ?? attr(e, "ShortText") ?? ""}`.trim())
        .join("; ");
    for (const v of Object.values(node)) {
      const found = this.findErrors(v);
      if (found) return found;
    }
    return "";
  }

  async pushReservation(msg: OutboundMessage, endpoint: string): Promise<PushResult> {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": msg.contentType, Accept: "text/xml, application/json", ...this.outboundHeaders() },
        body: msg.body,
        signal: AbortSignal.timeout(20_000),
      });
      const responseBody = await res.text();
      const verdict = this.isAccepted(res.status, responseBody);
      return { ok: verdict.ok, status: res.status, responseBody, error: verdict.error };
    } catch (err) {
      return { ok: false, status: 0, responseBody: "", error: (err as Error).message };
    }
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
