/**
 * Pins the launch Phase 2 schema: the Stripe ordering clock and processed-event ledger, the
 * one-customer-one-account index, the purge-run ledger, per-link recruiter PII, and the
 * one-time recruiter PII backfill.
 *
 * The backfill is exercised the only way it ever runs for real: rows written in the old
 * shape, the recorded version rewound by one, and the sweep re-run.
 *
 * Run: npx tsx scripts/smoke-launch-p2-schema.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, reconcileSchema, rowsOf } from "../src/db";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function columnsOf(table: string): Promise<Set<string>> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`
  );
  return new Set(rowsOf<{ column_name: string }>(res).map((r) => r.column_name));
}

type LinkPii = { email: string | null; phone: string | null; linkedin_url: string | null };

async function linkPii(recruiterId: string, userId: string): Promise<LinkPii | undefined> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT email, phone, linkedin_url FROM user_recruiter_links WHERE recruiter_id = ${recruiterId}::uuid AND user_id = ${userId}`
  );
  return rowsOf<LinkPii>(res)[0];
}

async function creatorOf(recruiterId: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT created_by_user_id FROM recruiters WHERE id = ${recruiterId}::uuid`
  );
  return rowsOf<{ created_by_user_id: string | null }>(res)[0]?.created_by_user_id ?? null;
}

async function rerunSweep() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  const result = await reconcileSchema();
  check("the sweep re-ran", result.applied === true, JSON.stringify(result));
  check(
    "no DDL statement failed",
    result.failed.length === 0,
    result.failed.map((f) => `${f.statement} -> ${f.message}`).join("; ")
  );
}

async function main() {
  const db = await getDb();

  console.log("New columns and tables");
  check("user_settings.subscription_event_at", (await columnsOf("user_settings")).has("subscription_event_at"));
  const processed = await columnsOf("stripe_processed_events");
  for (const c of ["event_id", "event_type", "processed_at"]) {
    check(`stripe_processed_events.${c}`, processed.has(c));
  }
  const runs = await columnsOf("data_purge_runs");
  for (const c of [
    "id",
    "target_user_id",
    "categories",
    "keep_settings",
    "full_purge",
    "completed_steps",
    "status",
    "attempts",
    "last_error",
    "requested_at",
    "last_attempt_at",
    "finished_at",
  ]) {
    check(`data_purge_runs.${c}`, runs.has(c));
  }
  check("data_purge_runs has no user_id column (smoke-purge would sweep it)", !runs.has("user_id"));
  check("recruiters.created_by_user_id", (await columnsOf("recruiters")).has("created_by_user_id"));
  const links = await columnsOf("user_recruiter_links");
  for (const c of ["email", "phone", "linkedin_url"]) {
    check(`user_recruiter_links.${c}`, links.has(c));
  }

  console.log("\nOne Stripe customer, one account");
  await db.execute(
    sql`INSERT INTO user_settings (user_id, stripe_customer_id) VALUES ('smoke-p2-a', 'cus_smoke_p2_dupe'), ('smoke-p2-n1', NULL), ('smoke-p2-n2', NULL)`
  );
  check("any number of accounts can have no Stripe customer", true);
  let rejected = false;
  try {
    await db.execute(
      sql`INSERT INTO user_settings (user_id, stripe_customer_id) VALUES ('smoke-p2-b', 'cus_smoke_p2_dupe')`
    );
  } catch {
    rejected = true;
  }
  check("a second account cannot claim the same Stripe customer", rejected);

  console.log("\nRecruiter PII backfill");
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const at = (ms: number) => new Date(base + ms).toISOString();
  const sole = randomUUID();
  const shared = randomUUID();
  const gmail = randomUUID();
  await db.execute(
    sql`INSERT INTO recruiters (id, full_name, name_normalized, email, email_normalized, created_at) VALUES (${sole}::uuid, 'Sole Smoke', 'sole smoke', 'sole@p2.test', 'sole@p2.test', ${at(0)}::timestamptz)`
  );
  await db.execute(
    sql`INSERT INTO recruiters (id, full_name, name_normalized, email, email_normalized, phone, linkedin_url, created_at) VALUES (${shared}::uuid, 'Shared Smoke', 'shared smoke', 'shared@p2.test', 'shared@p2.test', '+1 555 0100', 'https://www.linkedin.com/in/shared-smoke', ${at(0)}::timestamptz)`
  );
  await db.execute(
    sql`INSERT INTO recruiters (id, full_name, name_normalized, email, email_normalized, created_at) VALUES (${gmail}::uuid, 'Gmail Smoke', 'gmail smoke', 'gmail@p2.test', 'gmail@p2.test', ${at(0)}::timestamptz)`
  );
  const link = (recruiterId: string, userId: string, source: string, offsetMs: number) =>
    db.execute(
      sql`INSERT INTO user_recruiter_links (user_id, recruiter_id, source, created_at) VALUES (${userId}, ${recruiterId}::uuid, ${source}, ${at(offsetMs)}::timestamptz)`
    );
  await link(sole, "smoke-p2-u1", "manual", 60_000);
  await link(shared, "smoke-p2-u2", "manual", 30_000);
  await link(shared, "smoke-p2-u3", "manual", 2 * 86_400_000);
  await link(gmail, "smoke-p2-u4", "manual", 60_000);
  await link(gmail, "smoke-p2-u5", "gmail", 3 * 86_400_000);

  await rerunSweep();

  check("the sole linker is recorded as the creator", (await creatorOf(sole)) === "smoke-p2-u1");
  check("...and gets the email on their own link", (await linkPii(sole, "smoke-p2-u1"))?.email === "sole@p2.test");
  check("the earliest linker within 120 seconds is the creator", (await creatorOf(shared)) === "smoke-p2-u2");
  const creatorLink = await linkPii(shared, "smoke-p2-u2");
  check(
    "...and gets every shared field",
    creatorLink?.email === "shared@p2.test" &&
      creatorLink?.phone === "+1 555 0100" &&
      creatorLink?.linkedin_url === "https://www.linkedin.com/in/shared-smoke",
    JSON.stringify(creatorLink)
  );
  const laterLink = await linkPii(shared, "smoke-p2-u3");
  check(
    "a later manual linker gets nothing they did not contribute",
    laterLink?.email === null && laterLink?.phone === null && laterLink?.linkedin_url === null,
    JSON.stringify(laterLink)
  );
  const gmailLink = await linkPii(gmail, "smoke-p2-u5");
  check("a Gmail-scan linker gets the address it matched on", gmailLink?.email === "gmail@p2.test");
  check("...and nothing else", gmailLink?.phone === null && gmailLink?.linkedin_url === null);
  const sharedRow = rowsOf<{ email: string | null }>(
    await db.execute(sql`SELECT email FROM recruiters WHERE id = ${shared}::uuid`)
  )[0];
  check("the shared value itself is left in place", sharedRow?.email === "shared@p2.test");

  await db.execute(
    sql`UPDATE user_recruiter_links SET email = 'mine@p2.test' WHERE recruiter_id = ${sole}::uuid AND user_id = 'smoke-p2-u1'`
  );
  await rerunSweep();
  check(
    "a re-run never overwrites what a user put on their own link",
    (await linkPii(sole, "smoke-p2-u1"))?.email === "mine@p2.test"
  );

  await db.execute(sql`DELETE FROM recruiters WHERE id IN (${sole}::uuid, ${shared}::uuid, ${gmail}::uuid)`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id IN ('smoke-p2-a', 'smoke-p2-n1', 'smoke-p2-n2')`);
  console.log("\nAll Phase 2 schema checks passed.");
}

run(main);
