/**
 * Asserts the one "app pulse" that replaces three separate client pollers.
 *
 * Every authenticated tab used to run three timers, each a separate server-action round
 * trip: the notifications panel (120 s), the desktop-notification watcher (90 s, which
 * itself re-fetched the whole panel), and the plan-celebration watcher (75 s). One pulse
 * returns all three answers from one request: the panel, the due items not yet shown as
 * desktop notifications, and the current plan.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-app-pulse.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { loadAppPulse } from "../src/lib/app-pulse";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-app-pulse-user";
const DAY = 86_400_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);
  const now = new Date();
  const [due] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Due Person", nextFollowUpAt: new Date(now.getTime() - DAY) })
    .returning();
  const [later] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Later Person", nextFollowUpAt: new Date(now.getTime() + 3 * DAY) })
    .returning();
  // Follow-ups only alert for people the user has met or talked with (`met-contact.ts`).
  await db.insert(interactions).values(
    [due.id, later.id].map((contactId) => ({
      userId: USER,
      contactId,
      interactionType: "meeting" as const,
      interactionDate: new Date(now.getTime() - 10 * DAY),
    }))
  );
  // Someone merely in the address book, with a follow-up already due: never an alert.
  const [stranger] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Stranger Person", nextFollowUpAt: new Date(now.getTime() - DAY) })
    .returning();

  const pulse = await loadAppPulse(USER, now);
  check("carries the panel", pulse.panel.items.length >= 2 && typeof pulse.panel.dueCount === "number");
  check("carries the plan", pulse.plan === "free" || pulse.plan === "orbit" || pulse.plan === "lifetime", String(pulse.plan));
  const dueItem = pulse.panel.items.find((i) => i.kind === "follow_up" && i.contactId === due.id);
  check("the due follow-up is a due item", Boolean(dueItem) && pulse.dueItems.some((i) => i.id === dueItem!.id));
  check("upcoming items are not due items", !pulse.dueItems.some((i) => /Later Person/.test(i.title)));
  check(
    "a due follow-up for someone never met is not in the panel or the desktop alerts",
    !pulse.panel.items.some((i) => i.contactId === stranger.id) && !pulse.dueItems.some((i) => /Stranger Person/.test(i.title))
  );
  check("due items carry what a desktop notification needs",
    pulse.dueItems.every((i) => i.id && i.title && i.url));

  // Already shown as a desktop notification → not offered again.
  await db.update(userSettings).set({ desktopNotifiedIds: [dueItem!.id] }).where(eq(userSettings.userId, USER));
  const again = await loadAppPulse(USER, now);
  check("an already-notified due item is excluded from dueItems", !again.dueItems.some((i) => i.id === dueItem!.id));
  check("...but still counts in the panel", again.panel.dueCount === pulse.panel.dueCount);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll app-pulse checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
