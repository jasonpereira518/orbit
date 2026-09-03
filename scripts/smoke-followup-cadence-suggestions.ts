/**
 * buildOutreachSuggestions (via refreshOutreachSuggestions): a contact with no scheduled
 * follow-up but an aging open commitment, or a recent un-followed-up completion, must get
 * a discovery suggestion — and a contact who already has a scheduled follow-up must not,
 * since they've left the discovery population.
 * Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-followup-cadence-suggestions.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-cadence-suggestions";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-cadence-suggestions";
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, aiSuggestions, contacts, interactions } from "../src/db/schema";
import { actionItemHash } from "../src/lib/action-items";
import { refreshOutreachSuggestions } from "../src/lib/reminders";

const USER = "smoke-cadence-suggestions-user";

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

  const base = { userId: USER, priorityLevel: 0, relationshipScore: 2 } as const;

  const [openCommit] = await db.insert(contacts).values({ ...base, fullName: "Open Commit", lastInteractionAt: daysAgoDate(5) }).returning();
  const [closedLoop] = await db.insert(contacts).values({ ...base, fullName: "Closed Loop", lastInteractionAt: daysAgoDate(12) }).returning();
  const [control] = await db.insert(contacts).values({ ...base, fullName: "Control", lastInteractionAt: daysAgoDate(5) }).returning();
  // alreadyDue has an old open item too, but a nextFollowUpAt already scheduled —
  // it must NOT get an open_commitment suggestion, since it's left the discovery population.
  const [alreadyDue] = await db.insert(contacts).values({ ...base, fullName: "Already Due", lastInteractionAt: daysAgoDate(5), nextFollowUpAt: daysAgoDate(-3) }).returning();

  const [openCommitInteraction] = await db.insert(interactions).values({ userId: USER, contactId: openCommit.id, rawNotes: "x", interactionDate: daysAgoDate(40) }).returning();
  const [closedLoopInteraction] = await db.insert(interactions).values({ userId: USER, contactId: closedLoop.id, rawNotes: "x", interactionDate: daysAgoDate(12) }).returning();
  const [alreadyDueInteraction] = await db.insert(interactions).values({ userId: USER, contactId: alreadyDue.id, rawNotes: "x", interactionDate: daysAgoDate(40) }).returning();

  await db.insert(actionItems).values({
    userId: USER, contactId: openCommit.id, interactionId: openCommitInteraction.id,
    text: "Intro to Sam", status: "open",
    itemHash: actionItemHash(openCommitInteraction.id, "Intro to Sam"),
    createdAt: daysAgoDate(20),
  });

  await db.insert(actionItems).values({
    userId: USER, contactId: closedLoop.id, interactionId: closedLoopInteraction.id,
    text: "Sent the deck", status: "done", completedAt: daysAgoDate(5),
    itemHash: actionItemHash(closedLoopInteraction.id, "Sent the deck"),
  });

  await db.insert(actionItems).values({
    userId: USER, contactId: alreadyDue.id, interactionId: alreadyDueInteraction.id,
    text: "Old ask", status: "open",
    itemHash: actionItemHash(alreadyDueInteraction.id, "Old ask"),
    createdAt: daysAgoDate(20),
  });

  await refreshOutreachSuggestions(USER);

  const rows = await db
    .select({ contactId: aiSuggestions.relatedContactIds, suggestionType: aiSuggestions.suggestionType, description: aiSuggestions.description })
    .from(aiSuggestions)
    .where(eq(aiSuggestions.userId, USER));

  const byContact = new Map<string, { suggestionType: string; description: string }[]>();
  for (const r of rows) {
    const id = (r.contactId as string[] | null)?.[0];
    if (!id) continue;
    const list = byContact.get(id) ?? [];
    list.push({ suggestionType: r.suggestionType, description: r.description ?? "" });
    byContact.set(id, list);
  }

  const openCommitSuggestions = byContact.get(openCommit.id) ?? [];
  check(
    "openCommit gets an open_commitment suggestion quoting the item text",
    openCommitSuggestions.some((s) => s.suggestionType === "open_commitment" && s.description.includes("Intro to Sam")),
    JSON.stringify(openCommitSuggestions)
  );

  const closedLoopSuggestions = byContact.get(closedLoop.id) ?? [];
  check(
    "closedLoop gets a closed_the_loop suggestion quoting the item text",
    closedLoopSuggestions.some((s) => s.suggestionType === "closed_the_loop" && s.description.includes("Sent the deck")),
    JSON.stringify(closedLoopSuggestions)
  );

  check("control gets no suggestion at all", !byContact.has(control.id));
  check(
    "alreadyDue gets no open_commitment suggestion — it already has a scheduled follow-up",
    !(byContact.get(alreadyDue.id) ?? []).some((s) => s.suggestionType === "open_commitment"),
    JSON.stringify(byContact.get(alreadyDue.id))
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-followup-cadence-suggestions: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
