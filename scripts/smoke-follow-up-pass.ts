/**
 * The daily pass end to end: detect, score, cap, write, and re-run.
 *
 * The idempotency assertion is the important one. `.github/workflows/ops.yml` states
 * outright that its schedule is a floor rather than a promise, so a pass can fire twice
 * for the same user on the same day, and a duplicated card is the visible symptom.
 *
 * Run: npx tsx scripts/smoke-follow-up-pass.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  followUpSuggestions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import { runFollowUpPass } from "../src/lib/follow-ups/pass";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-pass-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function reset() {
  const db = await getDb();
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  const db = await getDb();
  await reset();
  await ensureUserSettings(USER);

  // Six dormant contacts — more than the daily cap of 3, so the cap is exercised.
  // Bare `.returning()`: getDb() is a union of the neon and pglite drivers, and the
  // pglite side rejects a projected `.returning({ ... })` at the type level.
  const inserted = await db
    .insert(contacts)
    .values(
      Array.from({ length: 6 }, (_, i) => ({
        userId: USER,
        fullName: `Dormant Person ${i}`,
        closenessTier: "inner" as const,
        priorityLevel: i,
        lastInteractionAt: ago(120),
        firstInteractionAt: ago(400),
        dateMet: ago(400),
      }))
    )
    .returning();

  // One contact spoken to two days ago. Filter 1 must drop them.
  const [fresh] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Spoke Yesterday",
      closenessTier: "inner",
      lastInteractionAt: ago(2),
      firstInteractionAt: ago(400),
      dateMet: ago(400),
    })
    .returning();

  console.log("\nfirst pass");
  const first = await runFollowUpPass(USER, { now: NOW });
  check("candidates were detected", first.detected > 0);
  check("the daily cap of 3 bounds what is written", first.written === 3, `wrote ${first.written}`);
  check("the shortlist is larger than what was written", first.shortlisted > first.written);

  const rows = await db.query.followUpSuggestions.findMany({
    where: eq(followUpSuggestions.userId, USER),
  });
  check("three rows exist", rows.length === 3);
  check("every row is pending", rows.every((r) => r.status === "pending"));
  check("every row has a human reason", rows.every((r) => r.reason.trim().length > 0));
  check("no row is marked judged in phase 1", rows.every((r) => r.judged === false));
  check("every row records its contributing signals", rows.every((r) => r.signals.length > 0));
  check(
    "the recently-contacted person was filtered out",
    !rows.some((r) => r.contactId === fresh.id)
  );
  check(
    "the highest-priority contacts won the cap",
    rows.every((r) => inserted.slice(3).some((c) => c.id === r.contactId))
  );

  console.log("\nno reminders were written");
  const reminderRows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check(
    "the engine wrote ZERO reminders rows — desktop notifications stay clean",
    reminderRows.length === 0
  );

  console.log("\nweights");
  const weights = await db.query.followUpWeights.findMany({
    where: eq(followUpWeights.userId, USER),
  });
  check("a weight row was created for the surfaced kind", weights.length === 1);
  check("shown counts the three surfaced cards", weights[0].shown === 3);
  check("nothing was accepted yet", weights[0].accepted === 0);

  console.log("\nsecond pass — idempotency");
  const second = await runFollowUpPass(USER, { now: NOW });
  const afterRows = await db.query.followUpSuggestions.findMany({
    where: eq(followUpSuggestions.userId, USER),
  });
  check("re-running the same day does not duplicate rows", afterRows.length === 3, `got ${afterRows.length}`);
  // Exactly zero, not "zero or unchanged": filter 5 (contactsWithPendingSuggestion)
  // removes these contacts before scoring, so a same-day re-run must write nothing. A
  // disjunction here would pass even with that filter broken.
  check("the second pass writes nothing at all", second.written === 0, `wrote ${second.written}`);

  console.log("\ndismissed rows survive a re-run");
  await db
    .update(followUpSuggestions)
    .set({ status: "dismissed", resolvedAt: NOW })
    .where(and(eq(followUpSuggestions.userId, USER), eq(followUpSuggestions.id, rows[0].id)));
  await runFollowUpPass(USER, { now: NOW });
  const afterDismiss = await db.query.followUpSuggestions.findFirst({
    where: eq(followUpSuggestions.id, rows[0].id),
  });
  check(
    "a re-run does NOT resurrect a dismissed suggestion",
    afterDismiss?.status === "dismissed"
  );

  await reset();
  console.log("\nAll follow-up pass checks passed.\n");
}

// `run` is the repo's own preamble helper: tsx will not exit on its own while PGlite's
// workers are alive, and every db-tier script in this repo ends this way.
run(main);
