/**
 * The scheduler for everything Orbit runs on a clock: Upstash QStash, configured from the
 * table below. Re-run after changing it; it upserts each `orbit-*` schedule by id and
 * deletes any `orbit-*` schedule the table no longer names.
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

config({ path: ".env.local" });
config();

type Schedule = { id: string; cron: string; method: "GET" | "POST"; path: string };

const SCHEDULES: Schedule[] = [
  // Every ten minutes: the alerting path, the outbound drains, the credit emails.
  { id: "ops-sweep", cron: "*/10 * * * *", method: "POST", path: "/api/ops/sweep" },
  { id: "webhooks-drain", cron: "*/10 * * * *", method: "POST", path: "/api/webhooks/outbound/drain" },
  { id: "connectors-outbox", cron: "*/10 * * * *", method: "POST", path: "/api/connectors/outbox/drain" },
  { id: "email-drain", cron: "*/10 * * * *", method: "POST", path: "/api/email/drain" },
  { id: "credit-notices", cron: "*/10 * * * *", method: "POST", path: "/api/credits/notices" },
  { id: "sync-run", cron: "*/15 * * * *", method: "POST", path: "/api/sync/run" },
  // Hourly, each on its own minute so no two long jobs are in flight together.
  { id: "process-stalled", cron: "7 * * * *", method: "GET", path: "/api/imports/process-stalled" },
  { id: "jobs-feed", cron: "23 * * * *", method: "POST", path: "/api/jobs/feed/sweep" },
  { id: "work-history", cron: "37 * * * *", method: "POST", path: "/api/work-history/sweep" },
  { id: "radar-feeds", cron: "53 * * * *", method: "POST", path: "/api/radar/feeds/sweep" },
  { id: "cloud-notes", cron: "29,59 * * * *", method: "POST", path: "/api/cloud-notes/run" },
  // Every hour of Sunday AND Monday UTC: the route sends only to people whose own Monday
  // 06:00–09:00 it is (Auckland's Monday morning is Sunday evening in UTC).
  { id: "radar-digest", cron: "13 * * * 0,1", method: "POST", path: "/api/radar/digest" },
  // Daily. Radar aims accounts at 04:00 UTC (radar_next_at).
  { id: "radar-run", cron: "17 4 * * *", method: "POST", path: "/api/radar/run" },
  { id: "speech-usage", cron: "41 5 * * *", method: "POST", path: "/api/ops/speech-usage" },
];

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
