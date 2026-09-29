// Partner DTO builders: PartnerSummary, PartnerDetail, PartnerProfile, CommissionRule[].
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { commissionRules, partners, partnerUsers, properties, roomTypes, users } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { iso, toCommissionRule, uniq } from "./dto";
import { buildAdminPropertyRows } from "./property-detail";

type PartnerRow = typeof partners.$inferSelect;

export async function buildPartnerSummaries(rows: PartnerRow[]) {
  if (!rows.length) return [];
  const counts = await db
    .select({ partnerId: properties.partnerId, n: count() })
    .from(properties)
    .where(inArray(properties.partnerId, rows.map((r) => r.id)))
    .groupBy(properties.partnerId);
  const countMap = new Map(counts.map((c) => [c.partnerId, c.n]));
  return rows.map((p) => summary(p, countMap.get(p.id) ?? 0));
}

const summary = (p: PartnerRow, propertyCount: number) => ({
  id: p.id,
  displayName: p.displayName,
  legalName: p.legalName,
  contactName: p.contactName,
  email: p.email,
  phone: p.phone,
  status: p.status,
  kycStatus: p.kycStatus,
  settlementCycle: p.settlementCycle,
  defaultCommissionType: p.defaultCommissionType,
  defaultCommissionValue: p.defaultCommissionValue,
  propertyCount,
  createdAt: iso(p.createdAt)!,
});

export async function listCommissionRules(partnerId: string) {
  const rows = await db
    .select()
    .from(commissionRules)
    .where(eq(commissionRules.partnerId, partnerId))
    .orderBy(desc(commissionRules.createdAt));
  return buildCommissionRules(rows);
}

export async function buildCommissionRules(rows: (typeof commissionRules.$inferSelect)[]) {
  const propIds = uniq(rows.map((r) => r.propertyId));
  const rtIds = uniq(rows.map((r) => r.roomTypeId));
  const [props, rts] = await Promise.all([
    propIds.length
      ? db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, propIds))
      : [],
    rtIds.length
      ? db.select({ id: roomTypes.id, name: roomTypes.name }).from(roomTypes).where(inArray(roomTypes.id, rtIds))
      : [],
  ]);
  const propMap = new Map(props.map((p) => [p.id, p.name]));
  const rtMap = new Map(rts.map((r) => [r.id, r.name]));
  return rows.map((r) =>
    toCommissionRule(r, {
      propertyName: r.propertyId ? propMap.get(r.propertyId) : null,
      roomTypeName: r.roomTypeId ? rtMap.get(r.roomTypeId) : null,
    }),
  );
}

/** PartnerProfile = PartnerDetail without users / properties / razorpayLinkedAccountId. */
export async function partnerProfile(partnerId: string) {
  const p = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
  if (!p) throw notFound("Partner");
  const [[{ n }], rules] = await Promise.all([
    db.select({ n: count() }).from(properties).where(eq(properties.partnerId, partnerId)),
    listCommissionRules(partnerId),
  ]);
  return {
    ...summary(p, n),
    address: p.address,
    gstin: p.gstin,
    pan: p.pan,
    bankAccountName: p.bankAccountName,
    bankAccountLast4: p.bankAccountLast4,
    bankIfsc: p.bankIfsc,
    kycNotes: p.kycNotes,
    settlementDayOfWeek: p.settlementDayOfWeek,
    settlementDayOfMonth: p.settlementDayOfMonth,
    settlementDelayDays: p.settlementDelayDays,
    defaultCancellationPolicy: p.defaultCancellationPolicy ?? null,
    defaultTerms: p.defaultTerms,
    commissionRules: rules,
  };
}

export async function partnerUsersList(partnerId: string) {
  const rows = await db
    .select({ user: users, permissions: partnerUsers.permissions })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(eq(partnerUsers.partnerId, partnerId))
    .orderBy(users.role, users.createdAt);
  return rows.map(({ user, permissions }) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    permissions,
  }));
}

export async function partnerDetail(partnerId: string) {
  const [profile, p, usersList, propRows] = await Promise.all([
    partnerProfile(partnerId),
    db.query.partners.findFirst({ where: eq(partners.id, partnerId) }),
    partnerUsersList(partnerId),
    db.select().from(properties).where(eq(properties.partnerId, partnerId)).orderBy(desc(properties.updatedAt)),
  ]);
  return {
    ...profile,
    razorpayLinkedAccountId: p!.razorpayLinkedAccountId,
    users: usersList,
    properties: await buildAdminPropertyRows(propRows),
  };
}

export async function partnerOwner(partnerId: string) {
  const [row] = await db
    .select({ user: users })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(and(eq(partnerUsers.partnerId, partnerId), eq(users.role, "PARTNER_OWNER")))
    .orderBy(users.createdAt)
    .limit(1);
  return row?.user ?? null;
}
