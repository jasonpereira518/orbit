/**
 * One scheduler per job. process-stalled ran hourly from GitHub AND daily from Vercel while
 * its own comment said daily. GitHub Actions is the one scheduler until Vercel Pro crons.
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
check("ops.yml keeps the hourly schedule", ops.includes(`- cron: "7 * * * *"`));
check("process-stalled is called from exactly one step",
  (ops.match(/\/api\/imports\/process-stalled/g) ?? []).length === 1);
check("that step is gated on the hourly schedule",
  /if: github\.event\.schedule == '7 \* \* \* \*'[\s\S]{0,400}\/api\/imports\/process-stalled/.test(ops));
check("the route no longer says it runs once a day", !/once\/day|Runs once/i.test(route));
check("the runbook carries the 60-day re-enable steps",
  runbook.includes("gh workflow enable ops.yml") && runbook.includes("disabled_inactivity"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll schedule checks passed.");
