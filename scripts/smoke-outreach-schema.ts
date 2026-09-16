/**
 * The generation-2 Outreach schema: the constraints later stages lean on for exactly-once
 * behaviour exist and bite. Each of these is a unique index doing a job a check-then-insert
 * cannot do under concurrency, so a missing one only shows up as a double send in production.
 *
 * Runs against a throwaway PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-outreach-schema.ts
 */
import "./smoke/_env";

import { run } from "./smoke/_env";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { sql } from "drizzle-orm";

const USER = "smoke-outreach-schema-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const db = await getDb();

  const tables = rowsOf<{ table_name: string }>(
    await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
  ).map((r) => r.table_name);
  for (const name of [
    "outreach_sender_accounts", "outreach_identities", "outreach_research_runs", "outreach_evidence",
    "outreach_research_attempts", "outreach_suppressions", "research_credit_accounts",
    "research_credit_holds", "research_credit_ledger", "outreach_jobs", "outreach_conversations",
    "outreach_drafts", "outreach_draft_versions", "outreach_send_batches", "outreach_runner_sessions",
    "outreach_send_attempts", "outreach_conversation_messages", "outreach_mail_sync_state",
  ]) {
    check(`${name} exists`, tables.includes(name));
  }

  const [campaign] = await db
    .insert(schema.outreachCampaigns)
    .values({ userId: USER, name: "Schema", generation: 2 })
    .returning();
  check("campaign generation defaults are writable", campaign.generation === 2 && campaign.criteriaVersion === 0);
  const [prospect] = await db
    .insert(schema.outreachProspects)
    .values({ userId: USER, campaignId: campaign.id, externalId: "li:ada", fullName: "Ada Lovelace" })
    .returning();
  check("prospect research_state defaults to none", prospect.researchState === "none");

  console.log("Identities are unique per campaign...");
  await db.insert(schema.outreachIdentities).values({
    userId: USER, campaignId: campaign.id, prospectId: prospect.id, kind: "linkedin_slug", value: "ada",
  });
  check(
    "a second prospect cannot claim the same identity in one campaign",
    await rejects(() =>
      db.insert(schema.outreachIdentities).values({
        userId: USER, campaignId: campaign.id, prospectId: prospect.id, kind: "linkedin_slug", value: "ada",
      })
    )
  );

  console.log("One live send attempt per draft...");
  const [draft] = await db
    .insert(schema.outreachDrafts)
    .values({ userId: USER, campaignId: campaign.id, prospectId: prospect.id, kind: "initial" })
    .returning();
  const [version] = await db
    .insert(schema.outreachDraftVersions)
    .values({
      userId: USER, draftId: draft.id, version: 1, channel: "email", fromAddress: "me@example.test",
      body: "Hello", renderedText: "Hello", contentHash: "h",
    })
    .returning();
  const attempt = {
    userId: USER, campaignId: campaign.id, draftId: draft.id, draftVersionId: version.id,
    contentHash: "h", method: "gmail_api" as const,
  };
  const [first] = await db.insert(schema.outreachSendAttempts).values(attempt).returning();
  check(
    "a second pending attempt for the same draft is refused",
    await rejects(() => db.insert(schema.outreachSendAttempts).values(attempt))
  );
  await db.execute(sql`UPDATE outreach_send_attempts SET state = 'failed' WHERE id = ${first.id}`);
  check(
    "after a failure a new attempt is allowed",
    !(await rejects(() => db.insert(schema.outreachSendAttempts).values(attempt)))
  );

  console.log("Messages dedupe on (user, dedupe_key)...");
  const [conversation] = await db
    .insert(schema.outreachConversations)
    .values({
      userId: USER, campaignId: campaign.id, prospectId: prospect.id, channel: "email",
      provider: "gmail", providerThreadId: "t1",
    })
    .returning();
  const message = {
    userId: USER, conversationId: conversation.id, direction: "inbound" as const, kind: "message" as const,
    occurredAt: new Date(), observedVia: "gmail" as const, dedupeKey: "gmail:m1",
  };
  await db.insert(schema.outreachConversationMessages).values(message);
  check(
    "the same provider message cannot be stored twice",
    await rejects(() => db.insert(schema.outreachConversationMessages).values(message))
  );
  check(
    "one provider thread is one conversation",
    await rejects(() =>
      db.insert(schema.outreachConversations).values({
        userId: USER, campaignId: campaign.id, prospectId: prospect.id, channel: "email",
        provider: "gmail", providerThreadId: "t1",
      })
    )
  );

  console.log("Job idempotency keys...");
  await db.insert(schema.outreachJobs).values({ userId: USER, kind: "discovery.run", idempotencyKey: "k1" });
  check(
    "a repeated idempotency key is refused",
    await rejects(() =>
      db.insert(schema.outreachJobs).values({ userId: USER, kind: "discovery.run", idempotencyKey: "k1" })
    )
  );
  await db.insert(schema.outreachJobs).values({ userId: USER, kind: "discovery.run" });
  check(
    "jobs without a key never collide",
    !(await rejects(() => db.insert(schema.outreachJobs).values({ userId: USER, kind: "discovery.run" })))
  );

  console.log("Credit ledger idempotency...");
  await db.insert(schema.researchCreditLedger).values({ userId: USER, entryType: "grant", idempotencyKey: "g1" });
  check(
    "a ledger key is written once",
    await rejects(() =>
      db.insert(schema.researchCreditLedger).values({ userId: USER, entryType: "grant", idempotencyKey: "g1" })
    )
  );

  console.log("All outreach schema checks passed.");
}

run(main);
