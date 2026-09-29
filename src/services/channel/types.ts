// Normalised channel-manager message model. Adapters translate provider wire formats (OTA XML, SOAP,
// JSON) to/from these shapes; everything else (mapping, ARI writes, reservation delivery) is provider-agnostic.
import type { ChannelManagerProvider } from "../../config/env";

export type Provider = ChannelManagerProvider;
export type WireFormat = "xml" | "json";
export type ReservationKind = "NEW" | "MODIFY" | "CANCEL";

/** One ARI instruction for a date range (start/end inclusive, like OTA StatusApplicationControl). */
export type AriUpdate = {
  roomCode: string;
  rateCode: string | null;
  start: string;
  end: string;
  days: number[] | null; // 0 = Sun … 6 = Sat; null = every day
  inventory?: number; // rooms the CM wants us to sell
  price?: number; // paise per room-night at base occupancy
  minStay?: number;
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
};

type Envelope = { messageType: string; echoToken?: string; soap?: boolean; credentials?: { username?: string; password?: string } };

export type InboundRequest =
  | (Envelope & { kind: "ARI"; hotelCode: string; updates: AriUpdate[] })
  | (Envelope & { kind: "READ"; hotelCode: string })
  | (Envelope & { kind: "ACK"; hotelCode: string | null; acks: { bookingCode: string; cmReference: string | null }[] });

export type ResponseContext = { messageType: string | null; echoToken?: string; soap?: boolean };

export type InboundError = { code: string; message: string; type?: string };

export type InboundResult =
  | { ok: true; kind: "ARI"; applied: number }
  | { ok: true; kind: "READ"; reservations: ReservationPayload[] }
  | { ok: true; kind: "ACK"; acked: number }
  | { ok: false; errors: InboundError[] };

export type ReservationPayload = {
  kind: ReservationKind;
  code: string;
  hotelCode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  guest: { name: string; email: string; phone: string };
  specialRequests: string | null;
  currency: string;
  roomAmount: number;
  roomTax: number;
  discountAmount: number;
  totalAmount: number;
  paidOnline: boolean;
  rooms: {
    cmRoomCode: string;
    cmRateCode: string | null;
    roomTypeName: string;
    ratePlanName: string;
    quantity: number;
    adults: number;
    children: number;
    nightly: { date: string; price: number }[];
    amount: number;
  }[];
};

export type OutboundMessage = { body: string; contentType: string; messageType: string };
export type PushResult = { ok: boolean; status: number; responseBody: string; error?: string };

export interface ChannelAdapter {
  readonly provider: Provider;
  readonly label: string;
  readonly slug: string; // URL segment: /channel/<slug>/…
  /** Parse a request body into a normalised request. Throws OtaError for malformed / unsupported messages. */
  parseInbound(body: string, format: WireFormat): InboundRequest;
  /** Check HTTP Basic or in-message (OTA POS RequestorID) credentials. */
  authenticateInbound(headers: Record<string, string | undefined>, req: InboundRequest | null): boolean;
  /** Build the success / error response the CM expects (messageType = request root, e.g. OTA_ReadRQ). */
  formatResponse(ctx: ResponseContext, result: InboundResult, format: WireFormat): { body: string; contentType: string };
  /** Reservation notification (OTA_HotelResNotifRQ or provider equivalent). */
  buildReservationMessage(r: ReservationPayload): OutboundMessage;
  /** Deliver a reservation message to the CM's endpoint. */
  pushReservation(msg: OutboundMessage, endpoint: string): Promise<PushResult>;
}

/** Error that becomes an OTA <Error Type Code> (codes from the OTA "EWT"/"ERR" code lists). */
export class OtaError extends Error {
  constructor(
    public code: string,
    message: string,
    public type = "3", // 3 = Business rule, 4 = Authentication, 12 = Processing exception
    public context?: ResponseContext,
  ) {
    super(message);
  }
}

export const OTA_ERR = {
  AUTH: ["497", "Authorization error", "4"],
  HOTEL: ["392", "Invalid hotel code", "3"],
  ROOM: ["402", "Invalid room type", "3"],
  RATE: ["249", "Invalid rate code", "3"],
  DATE: ["15", "Invalid date", "3"],
  REQUIRED: ["321", "Required field missing", "3"],
  UNSUPPORTED: ["450", "Unable to process — message type not supported", "12"],
  SYSTEM: ["448", "System error", "12"],
  FORMAT: ["459", "Invalid request format", "12"],
} as const;
