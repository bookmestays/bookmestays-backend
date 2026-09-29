// Background jobs. Simple interval timers with an in-process guard so a slow run never overlaps itself.
// (Across several API instances the jobs are still safe: every job uses row locks / compare-and-set /
// advisory locks, so running them twice at the same moment does no harm.)
import { completeStays, expireHolds } from "../services/bookings";
import { expireModificationHolds } from "../services/bookings/modify";
import { recalcPopularity } from "../services/catalog/popularity";
import { retryDuePushes } from "../services/channel/outbound";
import { generateSettlements } from "../services/settlements";
import { todayIST } from "../lib/utils";

const running = new Set<string>();

async function run(name: string, fn: () => Promise<unknown>) {
  if (running.has(name)) return;
  running.add(name);
  try {
    const result = await fn();
    if (typeof result === "number" && result > 0) console.log(`⏱  job ${name}: ${result}`);
  } catch (err) {
    console.error(`job ${name} failed`, err);
  } finally {
    running.delete(name);
  }
}

const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
  const timer = setInterval(() => void run(name, fn), ms);
  timer.unref?.();
  return timer;
};

/** Current IST time as minutes since midnight. */
const istMinutes = () => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

let lastSettlementRun: string | null = null;

export function startJobs() {
  if (process.env.DISABLE_JOBS === "true") return;
  every(60_000, "expire-holds", expireHolds);
  // keeps the "most booked" ranking fresh even if an event was missed
  every(60 * 60_000, "popularity", () => recalcPopularity());
  every(60_000, "expire-modification-holds", expireModificationHolds);
  every(60 * 60_000, "complete-stays", completeStays);
  every(5 * 60_000, "channel-retries", retryDuePushes);
  // Daily settlement run at 06:00 IST (checked every minute; catches up if the server was down at 06:00)
  every(60_000, "settlements", async () => {
    const today = todayIST();
    if (istMinutes() < 6 * 60 || lastSettlementRun === today) return 0;
    const created = await generateSettlements(today);
    lastSettlementRun = today;
    return created;
  });
  // Run the cheap catch-up jobs once shortly after boot
  setTimeout(() => {
    void run("expire-holds", expireHolds);
    void run("complete-stays", completeStays);
  }, 5_000).unref?.();
}
