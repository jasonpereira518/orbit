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

import { SCHEMA_VERSION } from "../src/db";
import { checkHealth } from "../src/lib/health";

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

  console.log("\nDeep probe...");
  const deep = await checkHealth({ deep: true });
  check("deep view includes cron, webhooks, config and alerts sections",
    "cron" in deep && "webhooks" in deep && "config" in deep && "alerts" in deep, Object.keys(deep).join(","));
  check("deep view on a healthy DB is still HTTP 200 (degraded is not down)", deep.httpStatus === 200);
  check("deep view names missing config, never values",
    Array.isArray((deep as { config?: { missingRequired?: unknown } }).config?.missingRequired));

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
