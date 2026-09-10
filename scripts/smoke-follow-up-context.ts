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
import { contacts, interactions, userSettings } from "../src/db/schema";
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

  // Idempotent teardown first, so a failed previous run cannot poison this one.
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

  console.log("\nscoring inputs");
  const inputs = await loadScoringInputs(USER, NOW);
  check("the default daily cap is 3", inputs.dailyCap === 3);
  check("no suppressions on a fresh user", inputs.suppressions.length === 0);
  check("no weights on a fresh user", inputs.weightsByKind.size === 0);

  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  console.log("\nAll follow-up context checks passed.\n");
}

// `run` is the repo's own preamble helper: tsx will not exit on its own while PGlite's
// workers are alive, and every db-tier script in this repo ends this way.
run(main);
