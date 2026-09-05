/**
 * Asserts the ops sweep end to end against PGlite: it evaluates conditions, records its
 * own run in `cron_runs`, persists alert state, and delivers ONLY on transitions.
 *
 * Deliveries are injected, so no Slack is involved. The scenario is the one production
 * will actually hit first: no nightly run has ever been recorded, so `cron.missed` opens
 * on the first sweep, stays quiet on the second, and recovers once a run is recorded.
 *
 * Run: npx tsx scripts/smoke-ops-sweep.ts
 */
import "./smoke/_env";
// Off Vercel nothing is required, so `config.missing` cannot fire and muddy the scenario.
delete process.env.VERCEL_ENV;

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { cronRuns, opsAlertState, webhookDeliveries } from "../src/db/schema";
import { finishCronRun, startCronRun } from "../src/lib/cron-runs";
import { runOpsSweep, type OpsDelivery } from "../src/lib/ops-sweep";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function reset() {
  const db = await getDb();
  await db
    .delete(cronRuns)
    .where(inArray(cronRuns.job, ["imports.process-stalled", "ops.sweep", "sync.run"]));
  // A healthy connector-sync run, so `sync.schedule_missed` stays quiet.
  //
  // This scenario is about the alert STATE MACHINE — open, remind, recover — and asserts an
  // exact delivery count to pin it. Leaving `sync.run` absent would fire a second, unrelated
  // condition and turn every count here into a running tally of the catalogue's size.
  await db.insert(cronRuns).values({
    job: "sync.run",
    status: "ok",
    trigger: "manual",
    startedAt: new Date(Date.now() - 5 * 60_000),
    finishedAt: new Date(Date.now() - 5 * 60_000),
  });
  // The whole table: it is local PGlite (DATABASE_URL deleted above) and every row is a
  // memory of what a previous sweep said, which is exactly what this scenario controls.
  await db.delete(opsAlertState);
  // Other smoke scripts leave rejected deliveries behind locally; a real streak would open
  // a second alert and muddy the "exactly one delivery" assertions below.
  await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.outcome, ["invalid", "error"]));
}

async function main() {
  await reset();
  const db = await getDb();
  const sent: OpsDelivery[] = [];
  let heartbeats = 0;
  const deps = {
    deliver: async (d: OpsDelivery) => { sent.push(d); },
    heartbeat: async () => { heartbeats += 1; },
  };

  console.log("First sweep on a fresh database...");
  const first = await runOpsSweep({ trigger: "manual", deps });
  check("sweep reports ok", first.status === "ok", JSON.stringify(first));
  check("cron.missed opened", first.opened.includes("cron.missed"), JSON.stringify(first));
  check("one delivery, an 'open' for cron.missed",
    sent.length === 1 && sent[0].kind === "open" && sent[0].condition.id === "cron.missed", JSON.stringify(sent));
  check("the delivery is a warning", sent[0]?.condition.severity === "warning");
  const row = await db.query.opsAlertState.findFirst({ where: eq(opsAlertState.id, "cron.missed") });
  check("state row persisted as active with one notification", row?.active === true && row?.notifyCount === 1, JSON.stringify(row));
  const sweepRuns = await db.query.cronRuns.findMany({ where: eq(cronRuns.job, "ops.sweep") });
  check("the sweep recorded itself in cron_runs as ok", sweepRuns.length === 1 && sweepRuns[0].status === "ok", JSON.stringify(sweepRuns));
  check("a completed sweep pings the heartbeat once", heartbeats === 1, `heartbeats=${heartbeats}`);

  console.log("\nSecond sweep, nothing changed...");
  sent.length = 0;
  const second = await runOpsSweep({ trigger: "manual", deps });
  check("no delivery when nothing changed", sent.length === 0, JSON.stringify(sent));
  check("cron.missed is reported as still active", second.active.includes("cron.missed"));

  console.log("\nA nightly run is recorded, then a sweep...");
  const handle = await startCronRun("imports.process-stalled", "manual");
  await finishCronRun(handle, { status: "ok" });
  sent.length = 0;
  const third = await runOpsSweep({ trigger: "manual", deps });
  check("cron.missed recovered", third.recovered.includes("cron.missed"), JSON.stringify(third));
  check("one 'recover' delivery", sent.length === 1 && sent[0].kind === "recover" && sent[0].condition.id === "cron.missed", JSON.stringify(sent));
  const after = await db.query.opsAlertState.findFirst({ where: eq(opsAlertState.id, "cron.missed") });
  check("state row is now inactive", after?.active === false);

  console.log("\nA critical condition routes to the critical channel too...");
  sent.length = 0;
  const forced = await runOpsSweep({
    trigger: "manual",
    deps,
    snapshotOverride: (s) => ({ ...s, stripeCheckoutErrorsLastHour: 2 }),
  });
  check("stripe.checkout_error opened", forced.opened.includes("stripe.checkout_error"));
  check("delivered as critical", sent.some((d) => d.kind === "open" && d.condition.severity === "critical"));

  await db.delete(opsAlertState).where(eq(opsAlertState.id, "stripe.checkout_error"));
  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ops-sweep checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
