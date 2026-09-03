/**
 * generateDueFollowUps: contacts with an aging open action item or a recent, un-followed-up
 * completion must become candidates even when idle time/priority/relationship score alone
 * would not select them — and a more urgent open item must outrank a less urgent one.
 * Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-followup-cadence-scoring.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-cadence-scoring";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-cadence-scoring";
delete process.env.DATABASE_URL;

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions, reminders } from "../src/db/schema";
import { actionItemHash } from "../src/lib/action-items";
import { generateDueFollowUps } from "../src/lib/reminders";

const USER = "smoke-cadence-scoring-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function daysAgoDate(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  // Low priority/relationship/idle for all four — only the new signal should distinguish them.
  // nextFollowUpAt is set a few hours out (not null, not yet due) so the pre-existing
  // "!nextFollowUpAt" catch-all doesn't trivially admit every contact including control.
  const soon = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const base = { userId: USER, priorityLevel: 0, relationshipScore: 2, nextFollowUpAt: soon } as const;

  const [oldItemHigh] = await db.insert(contacts).values({ ...base, fullName: "Old Item High", lastInteractionAt: daysAgoDate(5) }).returning();
  const [oldItemLow] = await db.insert(contacts).values({ ...base, fullName: "Old Item Low", lastInteractionAt: daysAgoDate(5) }).returning();
  const [completionOnly] = await db.insert(contacts).values({ ...base, fullName: "Completion Only", lastInteractionAt: daysAgoDate(12) }).returning();
  const [control] = await db.insert(contacts).values({ ...base, fullName: "Control", lastInteractionAt: daysAgoDate(5) }).returning();

  const [oldItemHighInteraction] = await db.insert(interactions).values({ userId: USER, contactId: oldItemHigh.id, rawNotes: "x", interactionDate: daysAgoDate(40) }).returning();
  const [oldItemLowInteraction] = await db.insert(interactions).values({ userId: USER, contactId: oldItemLow.id, rawNotes: "x", interactionDate: daysAgoDate(15) }).returning();
  const [completionOnlyInteraction] = await db.insert(interactions).values({ userId: USER, contactId: completionOnly.id, rawNotes: "x", interactionDate: daysAgoDate(12) }).returning();

  // oldItemHigh: open item 40 days old — should rank ahead of a 15-day-old one.
  await db.insert(actionItems).values({
    userId: USER, contactId: oldItemHigh.id, interactionId: oldItemHighInteraction.id,
    text: "Big ask", status: "open",
    itemHash: actionItemHash(oldItemHighInteraction.id, "Big ask"),
    createdAt: daysAgoDate(40),
  });

  // oldItemLow: open item 15 days old — just above the 14-day eligibility threshold.
  await db.insert(actionItems).values({
    userId: USER, contactId: oldItemLow.id, interactionId: oldItemLowInteraction.id,
    text: "Small ask", status: "open",
    itemHash: actionItemHash(oldItemLowInteraction.id, "Small ask"),
    createdAt: daysAgoDate(15),
  });

  // completionOnly: completed 5 days ago, after lastInteractionAt (12 days ago) — a
  // fresh, un-followed-up completion, with idle (12d) below the 14-day idle threshold.
  await db.insert(actionItems).values({
    userId: USER, contactId: completionOnly.id, interactionId: completionOnlyInteraction.id,
    text: "Sent the deck", status: "done", completedAt: daysAgoDate(5),
    itemHash: actionItemHash(completionOnlyInteraction.id, "Sent the deck"),
  });

  // control: no action items, idle only 5 days — must not qualify.

  const result = await generateDueFollowUps(USER, 10);

  check("oldItemHigh is a candidate", result.contactIds.includes(oldItemHigh.id));
  check("oldItemLow is a candidate", result.contactIds.includes(oldItemLow.id));
  check("completionOnly is a candidate", result.contactIds.includes(completionOnly.id));
  check("control is NOT a candidate — no idle/priority/relationship/action-item signal qualifies it", !result.contactIds.includes(control.id));
  check(
    "a 40-day-old open item outranks a 15-day-old one",
    result.contactIds.indexOf(oldItemHigh.id) < result.contactIds.indexOf(oldItemLow.id),
    JSON.stringify(result.contactIds)
  );

  const generatedReminders = await db
    .select({ contactId: reminders.contactId, status: reminders.status })
    .from(reminders)
    .where(and(eq(reminders.userId, USER), eq(reminders.reminderType, "generated")));
  const reminderContactIds = new Set(generatedReminders.map((r) => r.contactId));
  check("a pending reminder row exists for oldItemHigh", reminderContactIds.has(oldItemHigh.id));
  check("a pending reminder row exists for completionOnly", reminderContactIds.has(completionOnly.id));
  check("no reminder row exists for control", !reminderContactIds.has(control.id));

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-followup-cadence-scoring: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
