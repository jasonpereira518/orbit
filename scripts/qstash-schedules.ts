/**
 * The scheduler for everything Orbit runs on a clock: ONE Upstash QStash schedule, a tick every
 * five minutes, on the free tier. What runs when lives in `src/lib/schedules.ts`; the tick
 * route starts whatever is due. Re-run after changing this file; it upserts `orbit-tick` and
 * deletes any other `orbit-*` schedule (an earlier one-schedule-per-job setup included).
 *
 * Why not GitHub Actions: on this public repository GitHub fired ~36 of ~350 scheduled
 * `ops.yml` runs a day (Oct 2026), rotating through the cron lines, so the ten-minute sweep
 * — and the Better Stack heartbeat it pings — ran every two to four hours. `ops.yml` now
 * only reports deploy drift and probes health from outside.
 *
 * Each call carries the same `Authorization: Bearer $CRON_SECRET` the routes already check
 * (`isInternalRequest`), forwarded by QStash. No retries: the next tick is the retry, and a
 * retry is a billed message. All crons are UTC.
 *
 * Needs APP_URL (https://myorbitnetwork.com), CRON_SECRET (the production value) and
 * QSTASH_TOKEN (+ QSTASH_URL when the region is not the default), from `.env.local`.
 *
 * Run: npx tsx scripts/qstash-schedules.ts [--dry-run]
 */
import { config } from "dotenv";
import { TICK_MINUTES, TICK_PATH } from "../src/lib/schedules";

config({ path: ".env.local" });
config();

type Schedule = { id: string; cron: string; method: "GET" | "POST"; path: string };

// ONE schedule: the tick (`src/app/api/cron/tick`) starts every job in `src/lib/schedules.ts`
// that is due in its five-minute window. 288 calls a day keeps this on QStash's free tier
// (1,000 a day); a schedule per job would be about 1,100 a day and need a paid plan.
const SCHEDULES: Schedule[] = [{ id: "tick", cron: `*/${TICK_MINUTES} * * * *`, method: "POST", path: TICK_PATH }];

const PREFIX = "orbit-";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const appUrl = process.env.APP_URL?.trim().replace(/\/$/, "");
  const cronSecret = process.env.CRON_SECRET?.trim();
  const token = process.env.QSTASH_TOKEN?.trim();
  const qstash = (process.env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/$/, "");
  const missing = Object.entries({ APP_URL: appUrl, CRON_SECRET: cronSecret, QSTASH_TOKEN: token })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}`);
  if (!appUrl!.startsWith("https://")) throw new Error(`APP_URL must be https, got ${appUrl}`);

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${qstash}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
    return res;
  }

  for (const s of SCHEDULES) {
    console.log(`${dryRun ? "would set" : "set"} ${PREFIX}${s.id}  ${s.cron.padEnd(14)} ${s.method} ${s.path}`);
    if (dryRun) continue;
    await call(`/v2/schedules/${appUrl}${s.path}`, {
      method: "POST",
      headers: {
        "Upstash-Schedule-Id": `${PREFIX}${s.id}`,
        "Upstash-Cron": s.cron,
        "Upstash-Method": s.method,
        "Upstash-Retries": "0",
        "Upstash-Timeout": "300s",
        "Upstash-Forward-Authorization": `Bearer ${cronSecret}`,
      },
    });
  }

  const wanted = new Set(SCHEDULES.map((s) => `${PREFIX}${s.id}`));
  const existing = (await (await call("/v2/schedules")).json()) as { scheduleId: string }[];
  for (const { scheduleId } of existing) {
    if (!scheduleId.startsWith(PREFIX) || wanted.has(scheduleId)) continue;
    console.log(`${dryRun ? "would delete" : "delete"} ${scheduleId}`);
    if (!dryRun) await call(`/v2/schedules/${scheduleId}`, { method: "DELETE" });
  }
  console.log(dryRun ? "\nDry run: nothing changed." : `\n${SCHEDULES.length} schedules set.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
