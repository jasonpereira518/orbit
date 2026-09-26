/**
 * A profile ships the newest window of a contact's history, not all of it (`getContact`).
 *
 * A contact carrying an imported LinkedIn thread has thousands of interactions, and every
 * profile view used to ship every one to render forty. What the page derived from the whole
 * list now comes from SQL over the whole history: the total, per-type counts for the filter
 * chips, whether any REAL touch exists, the latest real touch, and the 90-day count. "Real"
 * is `isLoggedTouch`, so an AI-derived timeline event never counts. The rest of the history
 * loads on demand through `listContactTimeline`.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-contact-timeline-window.ts
 */
import "./smoke/_env";
// `getContact` goes through `requireUserId()`: with no Clerk keys and NODE_ENV=development
// that is demo mode's `demo-user`.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { getContact, getContactLabel, listContactTimeline } from "../src/actions/contacts";
import { AI_DERIVED_SOURCE } from "../src/lib/interaction-provenance";
import { interactionFrequencyLabel, formatInteractionFrequency } from "../src/lib/closeness";

const USER = "demo-user";
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
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Thread Heavy" }).returning();
  const now = Date.now();
  // 249 LinkedIn messages, one a day going back, plus one AI-derived event dated NEWEST of all.
  await db.insert(interactions).values([
    ...Array.from({ length: 249 }, (_, i) => ({
      userId: USER,
      contactId: contact!.id,
      interactionType: "linkedin_message" as const,
      interactionDate: new Date(now - (i + 1) * DAY),
      rawNotes: `message ${i}`,
    })),
    { userId: USER, contactId: contact!.id, interactionType: "note" as const, source: AI_DERIVED_SOURCE, interactionDate: new Date(now), rawNotes: "derived" },
  ]);

  const loaded = await getContact(contact!.id);
  check("a profile ships a window, not the whole history", loaded!.interactions.length === 200, String(loaded!.interactions.length));
  check("newest first", new Date(loaded!.interactions[0]!.interactionDate).getTime() >= new Date(loaded!.interactions[1]!.interactionDate).getTime());
  check("and says how many there are in all", loaded!.timeline.total === 250, String(loaded!.timeline.total));
  check("counted per type over the whole history", loaded!.timeline.typeCounts.linkedin_message === 249 && loaded!.timeline.typeCounts.note === 1, JSON.stringify(loaded!.timeline.typeCounts));
  check("a real touch exists", loaded!.timeline.hasLoggedInteraction);
  const latest = loaded!.timeline.latestLoggedAt ? new Date(loaded!.timeline.latestLoggedAt).getTime() : 0;
  check("the latest real touch skips the newer AI-derived event", Math.abs(latest - (now - DAY)) < 2000, String(loaded!.timeline.latestLoggedAt));
  const allDates = Array.from({ length: 249 }, (_, i) => new Date(now - (i + 1) * DAY));
  check("the 90-day frequency matches what counting every row said", interactionFrequencyLabel(loaded!.timeline.recentLoggedCount) === formatInteractionFrequency(allDates), `${loaded!.timeline.recentLoggedCount}`);

  const full = await listContactTimeline(contact!.id);
  check("the rest loads on demand, all of it, in the same order", full.length === 250 && full[0]!.id === loaded!.interactions[0]!.id);

  const [quiet] = await db.insert(contacts).values({ userId: USER, fullName: "Only Derived" }).returning();
  await db.insert(interactions).values({ userId: USER, contactId: quiet!.id, interactionType: "note", source: AI_DERIVED_SOURCE, interactionDate: new Date(now) });
  const q = await getContact(quiet!.id);
  check("a contact with only AI-derived events has no real touch", q!.timeline.hasLoggedInteraction === false && q!.timeline.latestLoggedAt === null);

  const label = await getContactLabel(contact!.id);
  check("a page that only names a contact gets its name, nothing else", label?.fullName === "Thread Heavy" && Object.keys(label!).length === 3, JSON.stringify(label));

  await db.delete(contacts).where(eq(contacts.id, contact!.id));
  await db.delete(contacts).where(eq(contacts.id, quiet!.id));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll contact timeline window checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
