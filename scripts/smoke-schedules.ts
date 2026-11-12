/**
 * One scheduler per job. process-stalled once ran hourly from GitHub AND daily from Vercel
 * while its own comment said daily. Now ONE outside schedule (a QStash tick every five
 * minutes, `scripts/qstash-schedules.ts`) calls `/api/cron/tick`, which starts the jobs in
 * `src/lib/schedules.ts` that are due; `ops.yml` only posts the drift sweep and probes health.
 *
 * Pure: reads files. Run: npx tsx scripts/smoke-schedules.ts
 */
import { readFileSync } from "node:fs";
import { JOB_SCHEDULES, TICK_MINUTES, TICK_PATH, cronMatches, dueJobs, tickWindow } from "../src/lib/schedules";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: unknown[] };
const ops = readFileSync(".github/workflows/ops.yml", "utf8");
const route = readFileSync("src/app/api/imports/process-stalled/route.ts", "utf8");
const runbook = readFileSync("docs/RUNBOOK.md", "utf8");

check("vercel.json schedules nothing", !vercel.crons || vercel.crons.length === 0, JSON.stringify(vercel.crons));
const qstash = readFileSync("scripts/qstash-schedules.ts", "utf8");
const publicRoutes = readFileSync("src/lib/public-routes.ts", "utf8");
const table = JOB_SCHEDULES;
const scheduled = (path: string) => table.filter((s) => s.path === path);

check("the job table has every job", table.length === 20, `${table.length} rows`);
check("every job id is unique", new Set(table.map((s) => s.id)).size === table.length);
for (const s of table) {
  check(`${s.path} is scheduled exactly once`, scheduled(s.path).length === 1);
  // proxy.ts exempts PUBLIC_ROUTES from Clerk; a scheduled path missing there gets a sign-in
  // redirect instead of the route, and QStash records a "success".
  check(`${s.path} is a public route`, publicRoutes.includes(`"${s.path}"`));
}
check("the ops sweep runs every ten minutes", scheduled("/api/ops/sweep")[0]?.cron === "*/10 * * * *");
check("process-stalled is a GET at :07", scheduled("/api/imports/process-stalled")[0]?.cron === "7 * * * *" &&
  scheduled("/api/imports/process-stalled")[0]?.method === "GET");
// The work-history sweep spends people's own AI keys: exactly one caller, on its own line.
check("the work-history sweep runs at :37", scheduled("/api/work-history/sweep")[0]?.cron === "37 * * * *");
check("QStash sets ONE schedule, the five-minute tick (free tier)",
  /const SCHEDULES: Schedule\[\] = \[\{ id: "tick", cron: `\*\/\$\{TICK_MINUTES\} \* \* \* \*`, method: "POST", path: TICK_PATH \}\];/.test(qstash) && TICK_PATH === "/api/cron/tick" && TICK_MINUTES === 5);
check("the tick is a public route", publicRoutes.includes(`"${TICK_PATH}"`));
check("QStash never retries (the next tick is the retry)", qstash.includes(`"Upstash-Retries": "0"`));
check("QStash forwards the cron bearer", qstash.includes("Upstash-Forward-Authorization") && qstash.includes("Bearer ${cronSecret}"));

check("ops.yml has one schedule", (ops.match(/- cron: /g) ?? []).length === 1 && ops.includes(`- cron: "*/30 * * * *"`));
const opsRoutes = [...new Set(ops.match(/\$APP_URL(\/api\/[\w/-]+)/g) ?? [])].sort();
check("ops.yml calls only the health probe and the drift sweep",
  JSON.stringify(opsRoutes) === JSON.stringify(["$APP_URL/api/health", "$APP_URL/api/ops/sweep"]), opsRoutes.join(", "));
check("the drift sweep posts where main is", ops.includes("mainSha") && ops.includes("git rev-parse HEAD"));
// The other jobs with their own cadence, and every job GitHub ran before this move (Nov 12 2026).
check("the email-intel sweep runs on its own quarter-hours", scheduled("/api/email-intel/sweep")[0]?.cron === "5,20,35,50 * * * *");
check("Radar's pass runs hourly at :17 (each account is due at its own local 5am)", scheduled("/api/radar/run")[0]?.cron === "17 * * * *");
const MOVED_FROM_GITHUB = [
  "/api/ops/sweep", "/api/imports/process-stalled", "/api/webhooks/outbound/drain", "/api/connectors/outbox/drain",
  "/api/email/drain", "/api/credits/notices", "/api/sync/run", "/api/jobs/feed/sweep", "/api/work-history/sweep",
  "/api/contacts/name-sweep", "/api/email-intel/sweep", "/api/radar/run", "/api/cloud-notes/run", "/api/radar/web",
  "/api/radar/digest", "/api/ops/billing-reconcile", "/api/ops/weekly-digest", "/api/ops/rollup",
  "/api/ops/speech-usage", "/api/contacts/monthly-upkeep",
];
const unscheduled = MOVED_FROM_GITHUB.filter((path) => scheduled(path).length === 0);
check("every job GitHub used to run is in the tick's table", unscheduled.length === 0, unscheduled.join(", "));

// The matcher, and a full simulated week of ticks: each job starts exactly as often as its cron says.
check("cron: */10 fires on the tens", cronMatches("*/10 * * * *", new Date("2026-11-16T10:20:00Z")) && !cronMatches("*/10 * * * *", new Date("2026-11-16T10:25:00Z")));
check("cron: a list fires on each minute in it", cronMatches("5,20,35,50 * * * *", new Date("2026-11-16T10:35:00Z")) && !cronMatches("5,20,35,50 * * * *", new Date("2026-11-16T10:30:00Z")));
check("cron: day of week (Monday)", cronMatches("47 13 * * 1", new Date("2026-11-16T13:47:00Z")) && !cronMatches("47 13 * * 1", new Date("2026-11-17T13:47:00Z")));
check("cron: day of month (the 1st)", cronMatches("19 3 1 * *", new Date("2026-12-01T03:19:00Z")) && !cronMatches("19 3 1 * *", new Date("2026-12-02T03:19:00Z")));
const weekStart = Date.parse("2026-11-29T00:00:00Z"); // a Sunday; the week crosses Dec 1
const starts = new Map<string, number>();
for (let t = weekStart; t < weekStart + 7 * 86_400_000; t += TICK_MINUTES * 60_000) {
  for (const job of dueJobs(new Date(t))) starts.set(job.id, (starts.get(job.id) ?? 0) + 1);
}
const perWeek: Record<string, number> = {
  "ops-sweep": 1008, "sync-run": 672, "email-intel": 672, "cloud-notes": 336, "process-stalled": 168, "radar-run": 168,
  "radar-web": 168, "radar-digest": 48, "ops-rollup": 7, "billing-reconcile": 7, "weekly-digest": 1, "contacts-upkeep": 1,
};
for (const [id, n] of Object.entries(perWeek)) check(`a week of ticks starts ${id} ${n} times`, starts.get(id) === n, String(starts.get(id)));
// A tick a minute or two late, or early, still stands for its own window: nothing repeats or goes missing.
const late = tickWindow(new Date("2026-11-16T10:21:40Z"));
const early = tickWindow(new Date("2026-11-16T10:18:30Z"));
check("a late or early tick covers the same window as an on-time one",
  late.to.toISOString() === "2026-11-16T10:20:00.000Z" && early.to.toISOString() === "2026-11-16T10:20:00.000Z");
check("Radar's :17 runs at the :20 tick, never at :15", dueJobs(new Date("2026-11-16T10:20:00Z")).some((j) => j.id === "radar-run") &&
  !dueJobs(new Date("2026-11-16T10:15:00Z")).some((j) => j.id === "radar-run"));
// A step that curls $APP_URL / $CRON_SECRET with no env block hits an empty host and a
// blank bearer, so the sweep silently never runs. Every such step declares what it uses.
for (const chunk of ops.split(/^ {6}- name: /m).slice(1)) {
  const name = chunk.split("\n", 1)[0];
  const body = chunk.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const [run = "", env = ""] = body.split(/^ {8}env:\s*$/m);
  for (const v of ["APP_URL", "CRON_SECRET"]) {
    if (new RegExp(`\\$${v}\\b`).test(run)) {
      check(`step "${name}" declares ${v} in its env`, new RegExp(`^\\s+${v}: \\$\\{\\{ secrets\\.${v} \\}\\}`, "m").test(env));
    }
  }
}
check("the route no longer says it runs once a day", !/once\/day|Runs once/i.test(route));
check("the runbook carries the 60-day re-enable steps",
  runbook.includes("gh workflow enable ops.yml") && runbook.includes("disabled_inactivity"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll schedule checks passed.");
