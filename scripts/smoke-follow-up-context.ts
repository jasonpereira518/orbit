/**
 * The context loader: shape, grouping, and its statement budget.
 *
 * The budget assertion is the point. Sources are pure over a preloaded context
 * specifically so thirteen detectors cost a fixed number of statements rather than
 * one per contact per source — if this number starts climbing, something started
 * querying that should not have.
 *
 * Run: npx tsx scripts/smoke-follow-up-context.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import { loadScoringInputs, loadSignalContext } from "../src/lib/follow-ups/context";
import { ensureUserSettings } from "../src/lib/user-settings";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-context-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function main() {
  const db = await getDb();

  // Idempotent teardown first, so a failed previous run cannot poison this one. Children
  // that reference `contacts` are deleted before `contacts` itself, even though their FKs
  // cascade — explicit beats implicit for a shared smoke database other scripts read too.
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpSuppressions).where(eq(followUpSuppressions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  // Bare `.returning()`: getDb() is a union of the neon and pglite drivers, and the
  // pglite side rejects a projected `.returning({ ... })` at the type level.
  const [priya] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Priya Raman",
      closenessTier: "mid",
      lastInteractionAt: ago(30),
      firstInteractionAt: ago(300),
      dateMet: ago(300),
    })
    .returning();

  await db.insert(interactions).values([
    {
      userId: USER,
      contactId: priya.id,
      interactionType: "linkedin_message",
      interactionDate: ago(30),
      direction: "in",
      rawNotes: "Any chance you could intro me to Dana?",
    },
    {
      userId: USER,
      contactId: priya.id,
      interactionType: "linkedin_message",
      interactionDate: ago(45),
      direction: "out",
      rawNotes: "good to meet you",
    },
    // Outside the 400-day window — must not be loaded.
    {
      userId: USER,
      contactId: priya.id,
      interactionType: "email",
      interactionDate: ago(500),
      direction: "out",
      rawNotes: "ancient history",
    },
  ]);

  console.log("\nshape");
  const ctx = await loadSignalContext(USER, NOW);
  check("the contact is loaded", ctx.contacts.length === 1);
  check("interactions are grouped by contact", ctx.interactionsByContact.get(priya.id)?.length === 2);
  check(
    "the 500-day-old interaction is outside the window",
    !ctx.interactionsByContact.get(priya.id)?.some((i) => i.text === "ancient history")
  );
  check(
    "interactions are newest-first — sources depend on [0]",
    ctx.interactionsByContact.get(priya.id)![0].text.startsWith("Any chance")
  );
  check("direction survives the round trip", ctx.interactionsByContact.get(priya.id)![0].direction === "in");
  check("empty maps are maps, not undefined", ctx.datesByContact instanceof Map && ctx.eventsByContact instanceof Map);
  check("`now` is carried on the context, not read from the clock", ctx.now.getTime() === NOW.getTime());

  console.log("\nreminders → dueCommitments vs contactsWithPendingReminder");
  // These two come out of ONE query and mean different things: pending membership is
  // due-date-agnostic (it drives a hard "don't stack on an existing reminder" filter),
  // dueCommitments is the arrived-only subset (it feeds the highest-priority signal).
  const [pastDueContact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Rachel Past-Due" })
    .returning();
  const [futureDueContact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Frank Future-Due" })
    .returning();
  const [nullDueContact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Nora No-Due-Date" })
    .returning();
  const [doneContact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Dana Done" })
    .returning();

  await db.insert(reminders).values([
    {
      userId: USER,
      contactId: pastDueContact.id,
      title: "Past-due reminder",
      dueDate: ago(1),
      status: "pending",
      reminderType: "manual",
      createdBy: "user",
    },
    {
      userId: USER,
      contactId: futureDueContact.id,
      title: "Future-due reminder",
      dueDate: ago(-10),
      status: "pending",
      reminderType: "manual",
      createdBy: "user",
    },
    {
      userId: USER,
      contactId: nullDueContact.id,
      title: "No-due-date reminder",
      dueDate: null,
      status: "pending",
      reminderType: "manual",
      createdBy: "user",
    },
    {
      userId: USER,
      contactId: doneContact.id,
      title: "Already-done reminder",
      dueDate: ago(1),
      status: "done",
      reminderType: "manual",
      createdBy: "user",
    },
  ]);

  const remCtx = await loadSignalContext(USER, NOW);
  check(
    "a past-due pending reminder's contact is in contactsWithPendingReminder",
    remCtx.contactsWithPendingReminder.has(pastDueContact.id)
  );
  check(
    "a future-due pending reminder's contact is ALSO in contactsWithPendingReminder — membership is due-date-agnostic",
    remCtx.contactsWithPendingReminder.has(futureDueContact.id)
  );
  check(
    "a null-due pending reminder's contact is ALSO in contactsWithPendingReminder",
    remCtx.contactsWithPendingReminder.has(nullDueContact.id)
  );
  check(
    "a done (non-pending) reminder's contact is NOT in contactsWithPendingReminder",
    !remCtx.contactsWithPendingReminder.has(doneContact.id)
  );

  check(
    "dueCommitments contains exactly one entry — only the arrived one",
    remCtx.dueCommitments.length === 1,
    `got ${remCtx.dueCommitments.length}`
  );
  check(
    "...and it's the past-due reminder, by contact and title",
    remCtx.dueCommitments[0]?.contactId === pastDueContact.id &&
      remCtx.dueCommitments[0]?.title === "Past-due reminder"
  );
  check(
    "a future-dated commitment does not leak into dueCommitments — catches a swapped comparison",
    !remCtx.dueCommitments.some((c) => c.contactId === futureDueContact.id)
  );
  check(
    "a null due date is excluded from dueCommitments (no date means not yet due)",
    !remCtx.dueCommitments.some((c) => c.contactId === nullDueContact.id)
  );

  console.log("\nstatement budget");
  startQueryCount();
  await loadSignalContext(USER, NOW);
  const contextCount = stopQueryCount();
  console.log(`  statements: ${contextCount}`);
  // Six parallel reads. Raise this deliberately and with a comment, never to make a
  // failing run pass.
  check("loadSignalContext issues <= 8 statements", contextCount <= 8, `got ${contextCount}`);

  startQueryCount();
  await loadScoringInputs(USER, NOW);
  const scoringCount = stopQueryCount();
  console.log(`  statements: ${scoringCount}`);
  check("loadScoringInputs issues <= 5 statements", scoringCount <= 5, `got ${scoringCount}`);

  console.log("\nsuppressions → the still-in-force filter");
  // `loadScoringInputs` keeps a suppression when `until IS NULL` (permanent) OR
  // `until >= now` (still active), and drops it once `until` is in the past. The
  // permanent-mute branch is the one most likely to be lost in a refactor — an `and`
  // in place of the `or`, or the NULL check dropped outright, would silently un-mute
  // every permanent mute a user ever set.
  await db.insert(followUpSuppressions).values([
    { userId: USER, contactId: null, kind: "thread_quiet", until: null, reason: "permanent mute" },
    { userId: USER, contactId: null, kind: "open_loop", until: ago(-10), reason: "snoozed a while" },
    { userId: USER, contactId: null, kind: "anniversary", until: ago(10), reason: "expired mute" },
  ]);

  console.log("\nweights → rows to Map, keyed by kind");
  // Values chosen to be exact in `real` (float4) so `===` is safe without an epsilon.
  await db.insert(followUpWeights).values([
    { userId: USER, kind: "thread_quiet", weight: 1.5 },
    { userId: USER, kind: "open_loop", weight: 0.5 },
  ]);

  console.log("\npending suggestions → contactsWithPendingSuggestion");
  const [suggestedContact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Sam Suggested" })
    .returning();
  await db.insert(followUpSuggestions).values({
    userId: USER,
    contactId: suggestedContact.id,
    dueOn: "2026-09-09",
    primaryKind: "thread_quiet",
    score: 0.75,
    reason: "smoke fixture",
    status: "pending",
  });

  console.log("\nscoring inputs");
  const inputs = await loadScoringInputs(USER, NOW);
  check("the default daily cap is 3", inputs.dailyCap === 3);

  check(
    "suppressions returns exactly the two still-in-force rows",
    inputs.suppressions.length === 2,
    `got ${inputs.suppressions.length}`
  );
  check(
    "a permanent mute (until: null) is returned — the branch most likely lost in a refactor",
    inputs.suppressions.some((s) => s.kind === "thread_quiet" && s.until === null)
  );
  check(
    "a future-dated mute is returned",
    inputs.suppressions.some((s) => s.kind === "open_loop" && s.until !== null)
  );
  check(
    "an expired mute is excluded",
    !inputs.suppressions.some((s) => s.kind === "anniversary")
  );

  check(
    "weightsByKind has both seeded rows",
    inputs.weightsByKind.size === 2,
    `got ${inputs.weightsByKind.size}`
  );
  check(
    "weightsByKind is keyed by kind, with values intact through the rows-to-Map conversion",
    inputs.weightsByKind.get("thread_quiet")?.weight === 1.5 &&
      inputs.weightsByKind.get("open_loop")?.weight === 0.5
  );

  check(
    "contactsWithPendingSuggestion contains the pending suggestion's contact",
    inputs.contactsWithPendingSuggestion.has(suggestedContact.id)
  );
  check(
    "...and only that contact",
    inputs.contactsWithPendingSuggestion.size === 1,
    `got ${inputs.contactsWithPendingSuggestion.size}`
  );

  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpSuppressions).where(eq(followUpSuppressions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  console.log("\nAll follow-up context checks passed.\n");
}

// `run` is the repo's own preamble helper: tsx will not exit on its own while PGlite's
// workers are alive, and every db-tier script in this repo ends this way.
run(main);
