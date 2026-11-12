/**
 * One scheduler per job. process-stalled once ran hourly from GitHub AND daily from Vercel
 * while its own comment said daily. QStash (`scripts/qstash-schedules.ts`) is the one
 * scheduler; `ops.yml` only posts the drift sweep and probes health.
 *
 * Pure: reads files. Run: npx tsx scripts/smoke-schedules.ts
 */
import { readFileSync } from "node:fs";

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
const table = [...qstash.matchAll(/\{ id: "([^"]+)", cron: "([^"]+)", method: "(GET|POST)", path: "([^"]+)" \}/g)]
  .map(([, id, cron, method, path]) => ({ id, cron, method, path }));
const scheduled = (path: string) => table.filter((s) => s.path === path);

check("the QStash table parses", table.length >= 14, `parsed ${table.length} rows`);
check("every QStash id is unique", new Set(table.map((s) => s.id)).size === table.length);
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
check("every job GitHub used to run has a QStash schedule", unscheduled.length === 0, unscheduled.join(", "));
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
