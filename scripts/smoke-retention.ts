/**
 * The retention table (src/lib/retention.ts) removes exactly what is past its period, and
 * nothing while it is in report mode.
 *
 * Two fake accounts are seeded across every table (privacy/lib/seed-everything): OLD has its
 * rows aged past every threshold and settled into terminal states; NEW has the same states
 * with today's timestamps. Report mode must count OLD and delete nothing; apply mode must
 * remove OLD's rows for every `ready` rule and keep every NEW row; `counsel` rules must not
 * apply in either mode. Feedback screenshots go with their feedback.
 *
 * Run: npx tsx scripts/smoke-retention.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { RETENTION_RULES, runRetention } from "../src/lib/retention";
import { readCatalog } from "../privacy/lib/catalog";
import { seedEverything } from "../privacy/lib/seed-everything";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const OLD = "user_retention_old";
const NEW = "user_retention_new";

/** Terminal states and, for OLD, timestamps past every threshold (400+ days). */
async function settle(user: string, aged: boolean) {
  const db = await getDb();
  const when = aged ? sql`now() - interval '800 days'` : sql`now()`;
  const x = (q: ReturnType<typeof sql>) => db.execute(q);
  await x(sql`UPDATE gate_events SET created_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE speech_usage SET created_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE webhook_deliveries SET created_at = ${when} WHERE target_user_id = ${user}`);
  await x(sql`UPDATE outbound_webhook_deliveries SET status = 'delivered', created_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE connector_outbox SET status = 'dead', created_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE ai_batch_jobs SET status = 'applied', completed_at = ${when}, updated_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE agent_send_requests SET status = 'expired', updated_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE import_job_rows SET status = 'done', payload = '{"name":"Zelda Quixote"}'::jsonb, updated_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE feedback SET status = 'resolved', status_changed_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE email_sends SET status = 'sent', sent_at = ${when} WHERE user_id = ${user}`);
  await x(sql`UPDATE admin_audit_log SET created_at = ${when} WHERE target_user_id = ${user}`);
  await x(sql`INSERT INTO cron_runs (job, status, started_at) VALUES (${`smoke.retention.${user}`}, 'ok', ${when})`);
}

async function rowsFor(user: string): Promise<Record<string, number>> {
  const db = await getDb();
  const n = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0);
  return {
    gate_events: await n(sql`SELECT count(*)::int AS n FROM gate_events WHERE user_id = ${user}`),
    speech_usage: await n(sql`SELECT count(*)::int AS n FROM speech_usage WHERE user_id = ${user}`),
    webhook_deliveries: await n(sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE target_user_id = ${user}`),
    outbound_webhook_deliveries: await n(sql`SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE user_id = ${user}`),
    connector_outbox: await n(sql`SELECT count(*)::int AS n FROM connector_outbox WHERE user_id = ${user}`),
    ai_batch_jobs: await n(sql`SELECT count(*)::int AS n FROM ai_batch_jobs WHERE user_id = ${user}`),
    agent_send_requests: await n(sql`SELECT count(*)::int AS n FROM agent_send_requests WHERE user_id = ${user}`),
    import_payloads: await n(sql`SELECT count(*)::int AS n FROM import_job_rows WHERE user_id = ${user} AND payload <> '{}'::jsonb`),
    import_rows: await n(sql`SELECT count(*)::int AS n FROM import_job_rows WHERE user_id = ${user}`),
    feedback: await n(sql`SELECT count(*)::int AS n FROM feedback WHERE user_id = ${user}`),
    feedback_screenshots: await n(sql`SELECT count(*)::int AS n FROM feedback_screenshots WHERE user_id = ${user}`),
    cron_runs: await n(sql`SELECT count(*)::int AS n FROM cron_runs WHERE job = ${`smoke.retention.${user}`}`),
    email_bodies: await n(sql`SELECT count(*)::int AS n FROM email_sends WHERE user_id = ${user} AND body_text <> ''`),
    admin_audit_log: await n(sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE target_user_id = ${user}`),
  };
}

async function main() {
  const cat = await readCatalog();
  await seedEverything(cat, OLD);
  await seedEverything(cat, NEW);
  await settle(OLD, true);
  await settle(NEW, false);
  const before = { old: await rowsFor(OLD), recent: await rowsFor(NEW) };
  check("the setup seeded a row in every table the rules touch", Object.values(before.old).every((v) => v >= 1), JSON.stringify(before.old));

  console.log("Report mode (the default)");
  const report = await runRetention({ mode: "report" });
  check("no rule errored", Object.values(report.rules).every((r) => !("error" in r)), JSON.stringify(report.rules));
  check("every ready rule found the aged row", RETENTION_RULES.filter((r) => r.status === "ready").every((r) => {
    const entry = report.rules[r.id];
    return entry && !("error" in entry) && entry.due >= 1;
  }), JSON.stringify(report.rules));
  check("nothing was removed", JSON.stringify(await rowsFor(OLD)) === JSON.stringify(before.old));

  console.log("\nApply mode");
  const applied = await runRetention({ mode: "apply" });
  const after = { old: await rowsFor(OLD), recent: await rowsFor(NEW) };
  for (const table of ["gate_events", "speech_usage", "webhook_deliveries", "outbound_webhook_deliveries", "connector_outbox", "ai_batch_jobs", "agent_send_requests", "feedback", "feedback_screenshots", "cron_runs"]) {
    check(`aged ${table} removed`, after.old[table] === 0, String(after.old[table]));
  }
  check("aged import rows keep their row but lose the raw payload", after.old.import_rows === before.old.import_rows && after.old.import_payloads === 0);
  check("every recent row is kept", JSON.stringify(after.recent) === JSON.stringify(before.recent), JSON.stringify(after.recent));
  check("counsel rules applied nothing (email bodies, audit log)", after.old.email_bodies === before.old.email_bodies && after.old.admin_audit_log === before.old.admin_audit_log);
  check("counsel rules report 0 applied", RETENTION_RULES.filter((r) => r.status === "counsel").every((r) => {
    const entry = applied.rules[r.id];
    return entry && !("error" in entry) && entry.applied === 0;
  }));

  console.log("\nIdempotent");
  const second = await runRetention({ mode: "apply", limit: 1 });
  check("a second pass has nothing left to do", RETENTION_RULES.filter((r) => r.status === "ready").every((r) => {
    const entry = second.rules[r.id];
    return entry && !("error" in entry) && entry.applied === 0;
  }));

  if (failures > 0) throw new Error(`${failures} retention check(s) failed`);
  console.log("\nAll retention checks passed.");
}

run(main);
