/**
 * The email-insights route: refuses anyone without the internal bearer, and with it runs both
 * phases and records both sets of numbers. PGlite; no account is opted in, so no Gmail or model
 * call is possible. Run: npx tsx scripts/smoke-email-intel-route.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { cronRuns, userSettings } from "../src/db/schema";
import { POST } from "../src/app/api/email-intel/sweep/route";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  process.env.CRON_SECRET = "smoke-email-intel-route";
  // The pglite tier shares one database across smokes, and the other email-intel smokes leave
  // their users opted in. "Nothing opted in" has to be made true here, not assumed.
  const db = await getDb();
  await db.update(userSettings).set({ emailIntelEnabled: 0 });
  await db.delete(cronRuns).where(eq(cronRuns.job, "email-intel.sweep"));
  const url = "http://localhost/api/email-intel/sweep";
  const post = (headers: Record<string, string> = {}) => POST(new Request(url, { method: "POST", headers }));

  check("no bearer is refused", (await post()).status === 401);
  check("a wrong bearer is refused", (await post({ authorization: "Bearer nope" })).status === 401);

  const res = await post({ authorization: "Bearer smoke-email-intel-route" });
  check("the right bearer is accepted", res.status === 200);
  const body = (await res.json()) as {
    ok: boolean;
    ingest: { accounts: number };
    extraction: { accounts: number; rejected: Record<string, number> } | null;
  };
  check("it reports the ingest phase", body.ok === true && typeof body.ingest.accounts === "number");
  check("and the extraction phase", body.extraction !== null && typeof body.extraction.accounts === "number");
  check("with nothing opted in, nothing happened", body.ingest.accounts === 0 && body.extraction!.accounts === 0);

  const runs = await db.select().from(cronRuns).where(eq(cronRuns.job, "email-intel.sweep"));
  check("exactly one run is recorded (the refused calls never start one)", runs.length === 1, String(runs.length));
  const done = runs.find((r) => r.status !== "running");
  check("and it finished ok", done?.status === "ok", String(done?.status));
  check("with flattened stats from both phases", "ingest_accounts" in (done?.stats ?? {}) && "extract_rejected_badKind" in (done?.stats ?? {}), JSON.stringify(done?.stats));

  console.log("\nAll email-intel route checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
