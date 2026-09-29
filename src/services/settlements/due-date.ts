import type { partners } from "../../db/schema";
import { addDays, diffDays, parseDate } from "../../lib/utils";

type Partner = Pick<
  typeof partners.$inferSelect,
  "settlementCycle" | "settlementDayOfWeek" | "settlementDayOfMonth" | "settlementDelayDays"
>;

// Fixed Monday used to decide which weeks are "on" weeks for BIWEEKLY settlements.
const BIWEEKLY_ANCHOR = "2024-01-01";

/**
 * API_CONTRACT §8: checkOut + settlementDelayDays, then rounded to the next cycle day (on or after):
 * WEEKLY → next settlementDayOfWeek, BIWEEKLY → that weekday on every other week,
 * MONTHLY → next settlementDayOfMonth (clamped to month length), AFTER_CHECKOUT → as is.
 */
export function settlementDueDate(p: Partner, checkOut: string): string {
  const base = addDays(checkOut, Math.max(0, p.settlementDelayDays ?? 0));
  const dow = (d: string) => parseDate(d).getUTCDay();
  switch (p.settlementCycle) {
    case "AFTER_CHECKOUT":
      return base;
    case "WEEKLY": {
      const target = p.settlementDayOfWeek ?? 1;
      return addDays(base, (target - dow(base) + 7) % 7);
    }
    case "BIWEEKLY": {
      const target = p.settlementDayOfWeek ?? 1;
      let d = addDays(base, (target - dow(base) + 7) % 7);
      if (Math.floor(diffDays(BIWEEKLY_ANCHOR, d) / 7) % 2 !== 0) d = addDays(d, 7);
      return d;
    }
    case "MONTHLY": {
      const day = Math.max(1, Math.min(31, p.settlementDayOfMonth ?? 1));
      const [y, m] = base.split("-").map(Number);
      const inMonth = (yy: number, mm: number) => {
        const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // mm is 1-based here
        return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
      };
      const candidate = inMonth(y, m);
      if (candidate >= base) return candidate;
      return m === 12 ? inMonth(y + 1, 1) : inMonth(y, m + 1);
    }
  }
}
