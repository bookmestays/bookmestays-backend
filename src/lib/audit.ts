import { db } from "../db";
import { auditLogs } from "../db/schema";
import type { AuthUser } from "./auth";

/** Records who did what. Never throws — auditing must not break the request. */
export async function audit(
  actor: AuthUser | null,
  action: string,
  entity: string,
  entityId?: string | null,
  data?: unknown,
) {
  await db
    .insert(auditLogs)
    .values({
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action,
      entity,
      entityId: entityId ?? null,
      data: data as object,
    })
    .catch((err) => console.error("audit failed", err));
}
