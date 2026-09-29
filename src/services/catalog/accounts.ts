// Helpers for creating partner/admin users and catalog rows that need unique slugs.
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db";
import { partners, partnerUsers, properties, users } from "../../db/schema";
import { conflict } from "../../lib/errors";
import { randomCode, randomPassword, slugify } from "../../lib/utils";

type Exec = typeof db | Tx;

export const normalizePhone = (p: string) => {
  const digits = p.replace(/\D/g, "");
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
};

export const STAFF_PERMISSIONS = ["content", "inventory", "bookings", "payouts", "reviews"] as const;

export async function assertUserUnique(exec: Exec, email: string, phone?: string | null, exceptUserId?: string) {
  const existing = await exec
    .select({ id: users.id, email: users.email, phone: users.phone })
    .from(users)
    .where(
      phone
        ? sql`(lower(${users.email}) = ${email.toLowerCase()} OR ${users.phone} = ${phone})`
        : sql`lower(${users.email}) = ${email.toLowerCase()}`,
    );
  const clash = existing.find((u) => u.id !== exceptUserId);
  if (clash)
    throw conflict(
      clash.email?.toLowerCase() === email.toLowerCase()
        ? "A user with this email already exists"
        : "A user with this phone number already exists",
    );
}

/** Creates a user with a random temporary password (must be changed on first login). */
export async function createUserWithTempPassword(
  exec: Exec,
  input: {
    name: string;
    email: string;
    phone?: string | null;
    role: "PARTNER_OWNER" | "PARTNER_STAFF" | "ADMIN_STAFF";
    password?: string;
  },
) {
  const email = input.email.trim().toLowerCase();
  const phone = input.phone ? normalizePhone(input.phone) : null;
  await assertUserUnique(exec, email, phone);
  const tempPassword = input.password ?? randomPassword();
  const [user] = await exec
    .insert(users)
    .values({
      name: input.name.trim(),
      email,
      phone,
      role: input.role,
      passwordHash: await Bun.password.hash(tempPassword),
      mustChangePassword: !input.password,
    })
    .returning();
  return { user, tempPassword };
}

export async function linkPartnerUser(exec: Exec, partnerId: string, userId: string, permissions: string[] = []) {
  await exec.insert(partnerUsers).values({ partnerId, userId, permissions });
}

/** Slug that is unique in `properties` (or `experiences`/`collections` via the checker). */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>) {
  const root = slugify(base).slice(0, 180) || randomCode(6).toLowerCase();
  if (!(await exists(root))) return root;
  for (let i = 2; i < 6; i++) if (!(await exists(`${root}-${i}`))) return `${root}-${i}`;
  return `${root}-${randomCode(5).toLowerCase()}`;
}

export const propertySlugExists = (exec: Exec) => async (slug: string) =>
  !!(await exec.select({ id: properties.id }).from(properties).where(eq(properties.slug, slug)).limit(1))[0];

/** Creates a DRAFT property inheriting the partner's default policies. */
export async function createPropertyShell(
  exec: Exec,
  partner: typeof partners.$inferSelect,
  input: Partial<typeof properties.$inferInsert> & { name: string },
) {
  let cityName = "";
  if (input.cityId) {
    const [c] = await exec.execute<{ name: string }>(sql`SELECT name FROM cities WHERE id = ${input.cityId}`);
    if (!c) throw conflict("Selected city does not exist");
    cityName = c.name;
  }
  const slug = await uniqueSlug(`${input.name} ${cityName}`, propertySlugExists(exec));
  const [row] = await exec
    .insert(properties)
    .values({
      cancellationPolicy: partner.defaultCancellationPolicy ?? null,
      terms: partner.defaultTerms ?? null,
      contactEmail: partner.email,
      contactPhone: partner.phone,
      ...input,
      partnerId: partner.id,
      slug,
      status: "DRAFT",
    })
    .returning();
  return row;
}
