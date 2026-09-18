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
import {
  KEEP_IN_TOUCH_MAX_DAYS,
  KEEP_IN_TOUCH_PRESETS,
  cadenceLabel,
  keepInTouchDescription,
  keepInTouchDue,
  normalizeCadence,
  type CadenceContact,
} from "../src/lib/keep-in-touch";
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
const NOW = new Date("2026-09-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const row = (over: Partial<CadenceContact> = {}): CadenceContact => ({
  contactId: "c1",
  keepInTouchDays: 90,
  lastInteractionAt: daysAgo(100),
  ...over,
});

function pureChecks() {
  section("Due when the stated interval has passed");

  check("past the interval is due", keepInTouchDue([row()], NOW).length === 1);
  check(
    "exactly the interval is due",
    keepInTouchDue([row({ lastInteractionAt: daysAgo(90) })], NOW).length === 1,
    "quarterly must fire ON day 90, not silently wait for 91"
  );
  check(
    "one day short is not",
    keepInTouchDue([row({ lastInteractionAt: daysAgo(89) })], NOW).length === 0
  );
  check(
    "the elapsed days are reported, not the interval",
    keepInTouchDue([row({ lastInteractionAt: daysAgo(104) })], NOW)[0]?.daysSince === 104
  );

  section("No cadence means no opinion");

  check("null is not a cadence", keepInTouchDue([row({ keepInTouchDays: null })], NOW).length === 0);
  check("zero is not a cadence", keepInTouchDue([row({ keepInTouchDays: 0 })], NOW).length === 0);
  check(
    "a negative is not a cadence",
    keepInTouchDue([row({ keepInTouchDays: -30 })], NOW).length === 0,
    "a negative interval is overdue by construction and cannot be cleared from the UI"
  );
  check("a missing timestamp is skipped", keepInTouchDue([row({ lastInteractionAt: null })], NOW).length === 0);
  check(
    "an unparseable timestamp is skipped",
    keepInTouchDue([row({ lastInteractionAt: "not-a-date" })], NOW).length === 0
  );
  check(
    "a future timestamp is not overdue",
    keepInTouchDue([row({ lastInteractionAt: new Date(NOW.getTime() + 86_400_000) })], NOW).length === 0
  );

  section("normalizeCadence is the only gate on what gets stored");

  check("rejects zero", normalizeCadence(0) === null);
  check("rejects negatives", normalizeCadence(-1) === null);
  check("rejects NaN", normalizeCadence(Number.NaN) === null);
  check("rejects Infinity", normalizeCadence(Number.POSITIVE_INFINITY) === null);
  check("rejects junk strings", normalizeCadence("soon") === null);
  check("rejects past the ceiling", normalizeCadence(KEEP_IN_TOUCH_MAX_DAYS + 1) === null);
  check("accepts the ceiling itself", normalizeCadence(KEEP_IN_TOUCH_MAX_DAYS) === KEEP_IN_TOUCH_MAX_DAYS);
  check("accepts a numeric string from a form field", normalizeCadence("90") === 90);
  check("rounds a fraction rather than storing it", normalizeCadence(90.4) === 90);
  check(
    "every preset the UI offers survives its own validator",
    KEEP_IN_TOUCH_PRESETS.every((p) => normalizeCadence(p.days) === p.days),
    "a preset the action would reject is a button that silently does nothing"
  );

  section("Ordering and copy");

  const many = keepInTouchDue(
    [
      row({ contactId: "slightly", lastInteractionAt: daysAgo(91) }),
      row({ contactId: "very", lastInteractionAt: daysAgo(400) }),
      row({ contactId: "somewhat", lastInteractionAt: daysAgo(120) }),
    ],
    NOW
  );
  check(
    "most overdue first",
    many.map((d) => d.contactId).join(",") === "very,somewhat,slightly",
    `got ${many.map((d) => d.contactId).join(",")}`
  );
  check("a preset reads as its own name", cadenceLabel(90) === "Quarterly");
  check("a custom interval still reads", cadenceLabel(45) === "Every 45 days");
  check(
    "the copy states the interval and the elapsed time",
    keepInTouchDescription(90, 104) === "Quarterly check-in — last touch 104 days ago",
    `got ${JSON.stringify(keepInTouchDescription(90, 104))}`
  );
  check("one day is singular", keepInTouchDescription(1, 1).includes("1 day ago"));
}

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

  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  pureChecks();
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
