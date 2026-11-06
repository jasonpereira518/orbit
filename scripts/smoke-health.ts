/**
 * Asserts the health probe in `src/lib/health.ts`, which backs `GET /api/health`.
 *
 * The probe is what the external uptime monitor and the GitHub Actions scheduler poll, so
 * it has three jobs: say 503 when the database is unreachable or the schema is behind
 * (the only two things that make the whole app wrong), never hang past the monitor's own
 * timeout, and never leak configuration to an unauthenticated caller. The deep view,
 * behind HEALTH_TOKEN, adds the operational facts the sweep also reads.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-health.ts
 */
import "./smoke/_env";

import { inArray } from "drizzle-orm";
import { SCHEMA_VERSION, getDb } from "../src/db";
import { cronRuns } from "../src/db/schema";
import { checkHealth } from "../src/lib/health";
import { getCronHealth } from "../src/lib/admin-system";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  console.log("Shallow probe...");
  const shallow = await checkHealth({ deep: false });
  check("healthy database → status ok, HTTP 200", shallow.status === "ok" && shallow.httpStatus === 200, JSON.stringify(shallow));
  check("reports the expected and recorded schema version",
    shallow.schema.expected === SCHEMA_VERSION && shallow.schema.recorded === SCHEMA_VERSION, JSON.stringify(shallow.schema));
  check("reports database latency", typeof shallow.db.latencyMs === "number" && shallow.db.latencyMs >= 0);
  check("shallow body carries no env names or config", !("config" in shallow) && !("cron" in shallow) && !("alerts" in shallow));
  check("carries the deployed sha field (null off Vercel)", "sha" in shallow);

  console.log("\nFailure modes...");
  const down = await checkHealth({ deep: false, probeDb: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:5432"); } });
  check("unreachable database → status down, HTTP 503", down.status === "down" && down.httpStatus === 503);
  check("the failure is a reason code, not the error message",
    down.db.reason === "db_error" && !JSON.stringify(down).includes("ECONNREFUSED"), JSON.stringify(down));

  const slow = await checkHealth({
    deep: false,
    timeoutMs: 50,
    probeDb: () => new Promise((resolve) => setTimeout(() => resolve({ recorded: SCHEMA_VERSION }), 500)),
  });
  check("a hanging database probe times out into 503 with db_timeout", slow.status === "down" && slow.db.reason === "db_timeout", JSON.stringify(slow));

  const behind = await checkHealth({ deep: false, probeDb: async () => ({ recorded: SCHEMA_VERSION - 1 }) });
  check("a schema behind the code → 503 with schema_mismatch", behind.status === "down" && behind.db.reason === "schema_mismatch", JSON.stringify(behind));

  const unrecorded = await checkHealth({ deep: false, probeDb: async () => ({ recorded: null }) });
  check("no recorded version → 503 with schema_mismatch", unrecorded.httpStatus === 503 && unrecorded.db.reason === "schema_mismatch", JSON.stringify(unrecorded));

  // A rollback: a newer deployment migrated the database, older code is serving. The monitor
  // and the ops scheduler both key on HTTP 200, so this must not read as "down".
  const ahead = await checkHealth({ deep: false, probeDb: async () => ({ recorded: SCHEMA_VERSION + 1 }) });
  check("a schema AHEAD of the code (a rollback) → HTTP 200, status degraded",
    ahead.httpStatus === 200 && ahead.status === "degraded" && ahead.db.reason === null && ahead.schema.ahead === true, JSON.stringify(ahead));
  const aheadDeep = await checkHealth({ deep: true, probeDb: async () => ({ recorded: SCHEMA_VERSION + 1 }) });
  check("…and the deep view stays degraded, not ok", aheadDeep.httpStatus === 200 && aheadDeep.status === "degraded");
  check("a current schema is not marked ahead", shallow.schema.ahead === false);

  console.log("\nDeep probe...");
  const deep = await checkHealth({ deep: true });
  check("deep view includes cron, webhooks, config and alerts sections",
    "cron" in deep && "webhooks" in deep && "config" in deep && "alerts" in deep, Object.keys(deep).join(","));
  check("deep view on a healthy DB is still HTTP 200 (degraded is not down)", deep.httpStatus === 200);
  check("deep view names missing config, never values",
    Array.isArray((deep as { config?: { missingRequired?: unknown } }).config?.missingRequired));
  // The runbook instructs setting statement_timeout on the Neon role and nothing verified
  // that anyone did. The probe reports whatever the role carries, so "is it set" has an
  // answer. PGlite reports its own default here; the assertion is that the field is read,
  // not what production's value happens to be.
  check("deep view reports the role's statement_timeout",
    typeof deep.config?.statementTimeout === "string" || deep.config?.statementTimeout === null,
    JSON.stringify(deep.config?.statementTimeout));

  // A dead scheduler: the nightly job's 25 h window is far too slow to notice that the
  // ten-minute ops sweep stopped, so the deep view also degrades when the sweep is quiet.
  console.log("\nDeep probe, scheduler liveness...");
  const db = await getDb();
  const JOBS = ["imports.process-stalled", "ops.sweep"];
  const seed = async (job: string, minutesAgo: number) => {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await db.insert(cronRuns).values({ job, trigger: "manual", status: "ok", startedAt: at, finishedAt: at });
  };
  try {
    await db.delete(cronRuns).where(inArray(cronRuns.job, JOBS));
    await seed("imports.process-stalled", 5);
    const neverSwept = await checkHealth({ deep: true });
    check("no sweep ever recorded → degraded, still HTTP 200",
      neverSwept.status === "degraded" && neverSwept.httpStatus === 200, JSON.stringify(neverSwept.cron));

    await seed("ops.sweep", 45);
    const quiet = await checkHealth({ deep: true });
    check("a sweep last seen 45 min ago → degraded, still HTTP 200",
      quiet.status === "degraded" && quiet.httpStatus === 200 && quiet.cron?.processStalled.missed === false,
      JSON.stringify(quiet.cron));

    await seed("ops.sweep", 5);
    const live = await checkHealth({ deep: true });
    // Control: with a live sweep the scheduler adds nothing. Other causes (missing config,
    // open alerts, issues left behind by earlier smokes on the shared database) can still
    // degrade the view, so only assert "ok" when none of them is present.
    const otherCause =
      (live.config?.missingRequired.length ?? 0) > 0 ||
      (live.alerts ?? []).some((a) => a.severity !== "info") ||
      Object.values(live.issues ?? {}).some((n) => n > 0);
    check("a sweep seen 5 min ago → the scheduler does not degrade the view",
      otherCause || live.status === "ok", JSON.stringify(live));

    // A sweep read that times out is unknown, not quiet: it must not degrade the view by itself.
    // Compared with the live run above, so any other cause cancels out.
    const unknown = await checkHealth({
      deep: true,
      cronHealth: (job, now) => (job === "ops.sweep" ? Promise.reject(new Error("timed out")) : getCronHealth(job, now)),
    });
    check("a timed-out sweep read is unknown → it does not degrade the view",
      unknown.cron?.sweep.state === null && unknown.status === live.status, JSON.stringify([unknown.status, live.status]));
  } finally {
    await db.delete(cronRuns).where(inArray(cronRuns.job, JOBS));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll health checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
