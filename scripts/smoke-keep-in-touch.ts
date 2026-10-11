/**
 * Keep-in-touch cadences: the one outreach signal the user states instead of Orbit guessing.
 *
 * Two properties matter here, and the second is the one that will break quietly.
 *
 *   1. A contact is due when more days have passed than the interval their user chose.
 *      Ordinary arithmetic, pinned at the boundary because "quarterly" firing at 89 days
 *      or never firing at 90 is the kind of off-by-one nobody reports, they just stop
 *      trusting the queue.
 *
 *   2. Setting a cadence SUPPRESSES `dormant_high_value` for that contact. Having been told
 *      how often, Orbit does not also apply its own 30-day guess — otherwise the mentor
 *      deliberately set to yearly is "gone quiet" for nine months out of twelve. This is a
 *      cross-module behaviour (a predicate in one file, a filter in another), so it is
 *      asserted against the real queue rather than by reading either one.
 *
 * Reworked when main was merged. This branch stored the interval in its own
 * `keep_in_touch_days` and raised a dedicated `keep_in_touch` suggestion; main had already
 * added `contacts.cadence_days` (with a `cadence_source` saying whether a note or the user
 * stated it) and feeds it to `idleThresholdFor`, so a cadence moves the dormancy threshold
 * to the interval the user chose instead of silencing the heuristic and replacing it. That
 * is the better answer — the mentor set to yearly is not muted for a year, they surface on
 * the day they are due — so the column and the suggestion type were both dropped and the
 * control that SETS a cadence now writes main's columns.
 *
 * Run: npx tsx scripts/smoke-keep-in-touch.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-keep-in-touch";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-keep-in-touch";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiSuggestions, contacts, userSettings } from "../src/db/schema";
import { refreshOutreachSuggestions } from "../src/lib/reminders";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const USER = "smoke-keep-in-touch-user";
/** The cross-module half: a cadence must actually reach the queue, and displace the guess. */
async function dbChecks() {
  const db = await getDb();
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const realDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  async function person(fullName: string, over: Record<string, unknown> = {}) {
    const [c] = await db
      .insert(contacts)
      .values({
        userId: USER,
        fullName,
        // High-value by the dormancy heuristic's own test, so every contact here WOULD be
        // called dormant if nothing suppressed it. That is the point.
        priorityLevel: 3,
        lastInteractionAt: realDaysAgo(200),
        ...over,
      })
      .returning();
    return c;
  }

  const yearly = await person("Yearly Yara", { cadenceDays: 365, cadenceSource: "user" });
  const quarterly = await person("Quarterly Quinn", { cadenceDays: 90, cadenceSource: "user" });
  const noCadence = await person("Unset Ursula");

  await refreshOutreachSuggestions(USER);
  const rows = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, USER) });
  const typeOf = (id: string) =>
    rows.find((r) => (r.relatedContactIds as string[] | null)?.includes(id))?.suggestionType ?? null;

  section("A cadence retunes the queue rather than silencing it");

  check(
    "a lapsed quarterly cadence surfaces",
    typeOf(quarterly.id) === "dormant_high_value",
    `got ${typeOf(quarterly.id)} — a cadence moves the idle threshold to the interval the user chose; it does not raise a separate row`
  );
  check(
    "a contact with no cadence still gets the heuristic",
    typeOf(noCadence.id) === "dormant_high_value",
    `got ${typeOf(noCadence.id)} — if this is null the control is broken, not the feature`
  );
  check(
    "a yearly cadence not yet lapsed is silent at 200 days",
    typeOf(yearly.id) === null,
    `got ${typeOf(yearly.id)} — "gone quiet" is exactly what a yearly cadence means NOT to say`
  );

  section("The description says something");

  const quinn = rows.find((r) => (r.relatedContactIds as string[] | null)?.includes(quarterly.id));
  check(
    "it reports how long it has actually been",
    /\d+ days? ago/.test(quinn?.description ?? ""),
    `got ${JSON.stringify(quinn?.description)}`
  );
  check("and the title is an action", (quinn?.title ?? "").startsWith("Reach out to"));

  section("Clearing a cadence hands the contact back to the heuristic");

  await db
    .update(contacts)
    .set({ cadenceDays: null, cadenceSource: null })
    .where(eq(contacts.id, yearly.id));
  await refreshOutreachSuggestions(USER);
  const after = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, USER) });
  const yaraAfter =
    after.find((r) => (r.relatedContactIds as string[] | null)?.includes(yearly.id))?.suggestionType ?? null;
  check(
    "silent under a year-long cadence, dormant once it is cleared",
    yaraAfter === "dormant_high_value",
    `got ${yaraAfter} — the threshold must be a live read of the column, not a one-time write`
  );

  section("The tier default reaches low-score contacts too");

  const lowScore = { priorityLevel: 0, relationshipScore: 2, lastInteractionAt: realDaysAgo(35) };
  const inner = await person("Inner Ines", { ...lowScore, closenessTier: "inner" });
  const outer = await person("Outer Otto", { ...lowScore, closenessTier: "outer" });
  await refreshOutreachSuggestions(USER);
  const tierRows = await db.query.aiSuggestions.findMany({ where: eq(aiSuggestions.userId, USER) });
  const tierTypeOf = (id: string) =>
    tierRows.find((r) => (r.relatedContactIds as string[] | null)?.includes(id))?.suggestionType ?? null;
  check("an inner contact 35 days quiet gets dormant_high_value", tierTypeOf(inner.id) === "dormant_high_value", `got ${tierTypeOf(inner.id)}`);
  check("an outer contact 35 days quiet gets none", tierTypeOf(outer.id) === null, `got ${tierTypeOf(outer.id)}`);

  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  await dbChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll keep-in-touch checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
