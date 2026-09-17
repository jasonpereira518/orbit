/**
 * The full-screen "Is your LinkedIn export ready?" reminder: who is owed it, and that it is
 * shown exactly once per account.
 *
 * Eligibility is a pure window over `user_settings.created_at` (the first-ever login) plus
 * two facts — the reminder has not been shown, and no LinkedIn import exists. The claim is
 * the part that has to hold under concurrency: two tabs loading at the same moment both see
 * `due`, and only one of them may draw the screen.
 *
 * Run: npx tsx scripts/smoke-linkedin-reminder.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { imports, userSettings } from "../src/db/schema";
import {
  LINKEDIN_NUDGE_MAX_AGE_MS,
  LINKEDIN_REMINDER_MAX_AGE_MS,
  LINKEDIN_REMINDER_MIN_AGE_MS,
  isLinkedInNudgeVisible,
  isLinkedInReminderDue,
} from "../src/lib/linkedin-export";
import {
  claimLinkedInReminderFor,
  getLinkedInReminderState,
  markLinkedInExportRequestedFor,
} from "../src/lib/linkedin-reminder";
import { LINKEDIN_IMPORT_TYPE } from "../src/lib/import-adapters/linkedin-connections";
import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "../src/lib/import-adapters/linkedin-messages";
import { ensureUserSettings } from "../src/lib/user-settings";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DUE = "smoke-li-reminder-due";
const FRESH = "smoke-li-reminder-fresh";
const OLD = "smoke-li-reminder-old";
const IMPORTED = "smoke-li-reminder-imported";
const MESSAGES_ONLY = "smoke-li-reminder-messages";
const USERS = [DUE, FRESH, OLD, IMPORTED, MESSAGES_ONLY];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(imports).where(inArray(imports.userId, USERS));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function createdAgo(userId: string, ms: number) {
  await ensureUserSettings(userId);
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(userSettings.userId, userId));
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (!row) throw new Error(`no settings row for ${userId}`);
  return row;
}

function pureChecks() {
  console.log("\neligibility window (pure)");
  const now = new Date("2026-09-17T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const due = (createdAt: Date, extra: Partial<Parameters<typeof isLinkedInReminderDue>[0]> = {}) =>
    isLinkedInReminderDue({ createdAt, shownAt: null, hasLinkedInImport: false, now, ...extra });

  check("the window opens at 24h", LINKEDIN_REMINDER_MIN_AGE_MS === DAY);
  check("the window closes at 14 days", LINKEDIN_REMINDER_MAX_AGE_MS === 14 * DAY);
  check("23h after first login: not yet", !due(ago(23 * HOUR)));
  check("exactly 24h: due", due(ago(DAY)));
  check("25h: due", due(ago(25 * HOUR)));
  check("13 days: still due", due(ago(13 * DAY)));
  check("15 days: too old, never shown", !due(ago(15 * DAY)));
  check("already shown: never again", !due(ago(25 * HOUR), { shownAt: ago(HOUR) }));
  check("already imported: never", !due(ago(25 * HOUR), { hasLinkedInImport: true }));
  check("a clock-skewed future createdAt: not due", !due(new Date(now.getTime() + HOUR)));

  console.log("\ndashboard nudge (pure)");
  const nudge = (extra: Partial<Parameters<typeof isLinkedInNudgeVisible>[0]>) =>
    isLinkedInNudgeVisible({
      createdAt: ago(2 * DAY),
      shownAt: null,
      requestedAt: null,
      hasLinkedInImport: false,
      now,
      ...extra,
    });
  check("hidden before the reminder or a request", !nudge({}));
  check("visible once the reminder was shown", nudge({ shownAt: ago(DAY) }));
  check("visible once the export was requested", nudge({ requestedAt: ago(HOUR) }));
  check("hidden after an import", !nudge({ requestedAt: ago(HOUR), hasLinkedInImport: true }));
  check(
    "hidden past 30 days",
    !nudge({ requestedAt: ago(HOUR), createdAt: ago(LINKEDIN_NUDGE_MAX_AGE_MS + HOUR) }),
  );
}

async function main() {
  console.log("LinkedIn reminder smoke test (pglite)…");
  pureChecks();
  await cleanup();

  try {
    console.log("\nserver state");
    const dueRow = await createdAgo(DUE, 25 * HOUR);
    const freshRow = await createdAgo(FRESH, 2 * HOUR);
    const oldRow = await createdAgo(OLD, 20 * DAY);
    const importedRow = await createdAgo(IMPORTED, 25 * HOUR);
    const messagesRow = await createdAgo(MESSAGES_ONLY, 25 * HOUR);

    const db = await getDb();
    await db.insert(imports).values([
      { userId: IMPORTED, importType: LINKEDIN_IMPORT_TYPE, status: "completed" },
      { userId: MESSAGES_ONLY, importType: LINKEDIN_MESSAGES_IMPORT_TYPE, status: "completed" },
    ]);

    check("25h, nothing imported: due", (await getLinkedInReminderState(DUE, dueRow)).due);
    check("2h old: not due", !(await getLinkedInReminderState(FRESH, freshRow)).due);
    check("20 days old: not due", !(await getLinkedInReminderState(OLD, oldRow)).due);
    check(
      "connections imported: not due",
      !(await getLinkedInReminderState(IMPORTED, importedRow)).due,
    );
    check(
      "messages imported: not due (the archive clearly arrived)",
      !(await getLinkedInReminderState(MESSAGES_ONLY, messagesRow)).due,
    );
    check("requested is false until stamped", !(await getLinkedInReminderState(DUE, dueRow)).requested);

    console.log("\nclaim");
    const claims = await Promise.all([
      claimLinkedInReminderFor(DUE),
      claimLinkedInReminderFor(DUE),
      claimLinkedInReminderFor(DUE),
    ]);
    check(
      "three concurrent claims: exactly one wins",
      claims.filter(Boolean).length === 1,
      JSON.stringify(claims),
    );
    check("a later claim loses", !(await claimLinkedInReminderFor(DUE)));
    const afterClaim = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, DUE) });
    check("the claim stamped shown_at", Boolean(afterClaim?.linkedinReminderShownAt));
    check(
      "and the state is no longer due",
      !(await getLinkedInReminderState(DUE, afterClaim!)).due,
    );
    check("a too-fresh account cannot claim", !(await claimLinkedInReminderFor(FRESH)));
    check("a too-old account cannot claim", !(await claimLinkedInReminderFor(OLD)));
    check("an imported account cannot claim", !(await claimLinkedInReminderFor(IMPORTED)));
    const importedAfter = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, IMPORTED),
    });
    check("a refused claim writes nothing", importedAfter?.linkedinReminderShownAt == null);

    console.log("\nrequested stamp");
    const first = await markLinkedInExportRequestedFor(FRESH);
    await new Promise((r) => setTimeout(r, 15));
    const second = await markLinkedInExportRequestedFor(FRESH);
    check("write-once: a second request keeps the first time", first.getTime() === second.getTime());
    const freshAfter = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, FRESH) });
    check(
      "requested shows through the state",
      (await getLinkedInReminderState(FRESH, freshAfter!)).requested,
    );
  } finally {
    await cleanup();
  }

  console.log("\nAll LinkedIn reminder checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
