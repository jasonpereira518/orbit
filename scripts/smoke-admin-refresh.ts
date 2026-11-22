/**
 * Ops › Refresh (`src/lib/admin-refresh-jobs.ts`, `runRefreshJobAction`).
 *
 * Pure: no job runs. Checks that every card can do something, that each all-users route
 * exists and logs an operator's run as `manual`, and that the action gates before it acts.
 *
 * Run: npx tsx scripts/smoke-admin-refresh.ts
 */
import "./smoke/_env";
import { existsSync, readFileSync } from "node:fs";
import { checker } from "./smoke/check";

async function main() {
  const t = checker();
  const { REFRESH_JOBS, findRefreshJob } = await import("../src/lib/admin-refresh-jobs");
  const { cronTrigger, CRON_TRIGGER_HEADER } = await import("../src/lib/cron-runs");

  const keys = REFRESH_JOBS.map((j) => j.key);
  t.check("job keys are unique", new Set(keys).size === keys.length);
  t.check("every job can run somehow", REFRESH_JOBS.every((j) => j.allRoute || j.runOne));
  t.check("unknown key finds nothing", findRefreshJob("nope") === null);

  for (const job of REFRESH_JOBS) {
    if (!job.allRoute) continue;
    const file = `src/app${job.allRoute.path}/route.ts`;
    t.check(`${job.key}: route file exists`, existsSync(file));
    const src = existsSync(file) ? readFileSync(file, "utf8") : "";
    t.check(
      `${job.key}: route exports ${job.allRoute.method}`,
      new RegExp(`export async function ${job.allRoute.method}\\b`).test(src)
    );
    t.check(
      `${job.key}: route logs the operator's trigger`,
      src.includes(`startCronRun("${job.cronJob}", cronTrigger(request))`)
    );
  }

  const req = (h?: string) =>
    new Request("http://x", { headers: h ? { [CRON_TRIGGER_HEADER]: h } : {} });
  t.check("header manual → manual", cronTrigger(req("manual")) === "manual");
  t.check("no header → schedule", cronTrigger(req()) === "schedule");
  t.check("other value → schedule", cronTrigger(req("admin")) === "schedule");

  const actions = readFileSync("src/actions/admin.ts", "utf8");
  const body = actions.slice(actions.indexOf("export async function runRefreshJobAction"));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  const at = (s: string) => fn.indexOf(s);
  t.check("action exists", fn.length > 0 && at("requireAdminUserId()") > 0);
  t.check("gate comes before reason, lookup and runs", at("requireAdminUserId()") < at("requireReason"));
  t.check("audit row before a one-user run", at("recordAdminAction") < at("job.runOne(userId)"));
  t.check("all-users run happens in after()", /after\(\(\) =>\s*runRefreshJobForAll/.test(fn));

  t.done("admin refresh smoke tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
