/**
 * Pins the CSP violation receiver at `POST /api/csp-report`.
 *
 * Reports land in `error_events` under the `csp.report` source with the violated directive
 * as the low-cardinality `kind` and the blocked URI in context — bounded by a once-per-hour
 * latch per (directive, blocked URI), so a noisy browser extension cannot write a row per
 * page view. Hobby runtime logs keep an hour; a week of report-only data has to live here.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-csp-report.ts
 */
import "./smoke/_env";

import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents } from "../src/db/schema";
import { POST } from "../src/app/api/csp-report/route";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const STARTED = new Date();
const uri = `https://evil.example/${Date.now()}.js`;

function report(over: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: JSON.stringify({
      "csp-report": {
        "document-uri": "https://orbit.jasonpereira.live/dashboard",
        "effective-directive": "script-src",
        "blocked-uri": uri,
        "violated-directive": "script-src",
        ...over,
      },
    }),
  });
}

async function rows() {
  const db = await getDb();
  return db
    .select()
    .from(errorEvents)
    .where(and(eq(errorEvents.source, "csp.report"), gte(errorEvents.createdAt, STARTED)));
}

async function main() {
  const first = await POST(report());
  check("a report is accepted with 204", first.status === 204, String(first.status));
  let got = await rows();
  check("it becomes one error_events row", got.length === 1, `rows=${got.length}`);
  check("kind is the effective directive", got[0]?.kind === "script-src");
  check("context carries the blocked URI and document path, not the whole report",
    (got[0]?.context as { blockedUri?: string; documentPath?: string })?.blockedUri === uri &&
      (got[0]?.context as { documentPath?: string })?.documentPath === "/dashboard",
    JSON.stringify(got[0]?.context));

  await POST(report());
  await POST(report());
  got = await rows();
  check("repeats within the hour are throttled to the one row", got.length === 1, `rows=${got.length}`);

  const other = await POST(report({ "blocked-uri": `${uri}?other` }));
  check("a different blocked URI is a new row", other.status === 204 && (await rows()).length === 2);

  const huge = new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(20_000) } }),
  });
  check("an oversize body is refused with 413", (await POST(huge)).status === 413);

  const garbage = new Request("http://localhost/api/csp-report", { method: "POST", body: "not json" });
  check("garbage is dropped quietly (204, no row)", (await POST(garbage)).status === 204 && (await rows()).length === 2);

  const db = await getDb();
  await db.delete(errorEvents).where(and(eq(errorEvents.source, "csp.report"), gte(errorEvents.createdAt, STARTED)));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll csp-report checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
