/**
 * getActionItemSignalsBatch: batched open/completion signals used to make follow-up
 * cadence smarter. Exercises the self-silencing rule (a completion superseded by a
 * later interaction must not count) and the "oldest open item wins" selection, against
 * a real (small) PGlite dataset. Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-action-item-signals.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-action-item-signals";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-action-item-signals";
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions } from "../src/db/schema";
import { actionItemHash } from "../src/lib/action-items";
import { getActionItemSignalsBatch } from "../src/lib/action-item-signals";

const USER = "smoke-action-item-signals-user";

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

  const [oldOpen] = await db.insert(contacts).values({ userId: USER, fullName: "Old Open" }).returning();
  const [multiOpen] = await db.insert(contacts).values({ userId: USER, fullName: "Multi Open" }).returning();
  const [freshClose] = await db.insert(contacts).values({ userId: USER, fullName: "Fresh Close", lastInteractionAt: daysAgoDate(15) }).returning();
  const [alreadyFollowedUp] = await db.insert(contacts).values({ userId: USER, fullName: "Already Followed Up", lastInteractionAt: daysAgoDate(3) }).returning();
  const [noSignal] = await db.insert(contacts).values({ userId: USER, fullName: "No Signal" }).returning();
  const [outsideWindow] = await db.insert(contacts).values({ userId: USER, fullName: "Outside Window", lastInteractionAt: daysAgoDate(50) }).returning();

  const [oldOpenInteraction] = await db.insert(interactions).values({ userId: USER, contactId: oldOpen.id, rawNotes: "x", interactionDate: daysAgoDate(20) }).returning();
  const [multiOpenInteraction] = await db.insert(interactions).values({ userId: USER, contactId: multiOpen.id, rawNotes: "x", interactionDate: daysAgoDate(20) }).returning();
  const [freshCloseInteraction] = await db.insert(interactions).values({ userId: USER, contactId: freshClose.id, rawNotes: "x", interactionDate: daysAgoDate(15) }).returning();
  const [alreadyFollowedUpInteraction] = await db.insert(interactions).values({ userId: USER, contactId: alreadyFollowedUp.id, rawNotes: "x", interactionDate: daysAgoDate(20) }).returning();
  const [outsideWindowInteraction] = await db.insert(interactions).values({ userId: USER, contactId: outsideWindow.id, rawNotes: "x", interactionDate: daysAgoDate(50) }).returning();

  // oldOpen: one open item, 20 days old.
  await db.insert(actionItems).values({
    userId: USER, contactId: oldOpen.id, interactionId: oldOpenInteraction.id,
    text: "Send the intro doc", status: "open",
    itemHash: actionItemHash(oldOpenInteraction.id, "Send the intro doc"),
    createdAt: daysAgoDate(20),
  });

  // multiOpen: two open items, 5 and 20 days old — the OLDER one should win.
  await db.insert(actionItems).values({
    userId: USER, contactId: multiOpen.id, interactionId: multiOpenInteraction.id,
    text: "Recent ask", status: "open",
    itemHash: actionItemHash(multiOpenInteraction.id, "Recent ask"),
    createdAt: daysAgoDate(5),
  });
  await db.insert(actionItems).values({
    userId: USER, contactId: multiOpen.id, interactionId: multiOpenInteraction.id,
    text: "Older ask", status: "open",
    itemHash: actionItemHash(multiOpenInteraction.id, "Older ask"),
    createdAt: daysAgoDate(20),
  });

  // freshClose: completed 5 days ago, AFTER lastInteractionAt (15 days ago) — must count.
  await db.insert(actionItems).values({
    userId: USER, contactId: freshClose.id, interactionId: freshCloseInteraction.id,
    text: "Send the deck", status: "done", completedAt: daysAgoDate(5),
    itemHash: actionItemHash(freshCloseInteraction.id, "Send the deck"),
  });

  // alreadyFollowedUp: completed 20 days ago, BEFORE lastInteractionAt (3 days ago) — a
  // later interaction already closed the loop, so this must be self-silenced.
  await db.insert(actionItems).values({
    userId: USER, contactId: alreadyFollowedUp.id, interactionId: alreadyFollowedUpInteraction.id,
    text: "Send the deck", status: "done", completedAt: daysAgoDate(20),
    itemHash: actionItemHash(alreadyFollowedUpInteraction.id, "Send the deck"),
  });

  // outsideWindow: completed 45 days ago — outside the 30-day query window entirely.
  await db.insert(actionItems).values({
    userId: USER, contactId: outsideWindow.id, interactionId: outsideWindowInteraction.id,
    text: "Old task", status: "done", completedAt: daysAgoDate(45),
    itemHash: actionItemHash(outsideWindowInteraction.id, "Old task"),
  });

  const result = await getActionItemSignalsBatch(USER, [
    oldOpen.id, multiOpen.id, freshClose.id, alreadyFollowedUp.id, noSignal.id, outsideWindow.id,
  ]);

  const oldOpenSignal = result.get(oldOpen.id);
  check(
    "oldOpen has openCount 1 and ~20 days old",
    oldOpenSignal?.openCount === 1 && (oldOpenSignal?.oldestOpenAgeDays ?? 0) >= 19 && (oldOpenSignal?.oldestOpenAgeDays ?? 0) <= 21,
    JSON.stringify(oldOpenSignal)
  );

  const multiOpenSignal = result.get(multiOpen.id);
  check(
    "multiOpen has openCount 2 and picks the OLDER item as oldestOpenText",
    multiOpenSignal?.openCount === 2 && multiOpenSignal?.oldestOpenText === "Older ask",
    JSON.stringify(multiOpenSignal)
  );

  const freshCloseSignal = result.get(freshClose.id);
  check(
    "freshClose has a recent completion, ~5 days old",
    freshCloseSignal?.recentCompletionText === "Send the deck" && (freshCloseSignal?.recentCompletionAgeDays ?? -1) >= 4 && (freshCloseSignal?.recentCompletionAgeDays ?? -1) <= 6,
    JSON.stringify(freshCloseSignal)
  );

  check(
    "alreadyFollowedUp is absent entirely — its only completion is self-silenced by a later interaction",
    result.get(alreadyFollowedUp.id) === undefined,
    JSON.stringify(result.get(alreadyFollowedUp.id))
  );

  check("noSignal is absent from the Map entirely", result.get(noSignal.id) === undefined);
  check("outsideWindow's 45-day-old completion falls outside the query window, absent from the Map", result.get(outsideWindow.id) === undefined);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-action-item-signals: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
