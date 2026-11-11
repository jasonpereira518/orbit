/**
 * Also here (people at the same event), end to end against a throwaway PGlite. One section per task.
 *
 * Run: npx tsx scripts/smoke-also-here.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { appSurfaceFlags, eventAliases, events, shareCards, userSettings } from "../src/db/schema";
import { DEFAULT_CARD_FIELDS, loadPublicCardForOwner, saveCard, setCardPaused } from "../src/lib/cards/card-store";
import { isDiscoverable, setDiscoverable, setHiddenAtEvent } from "../src/lib/nearby/discoverability";
import { alsoHereFor, isLiveAttendedEvent } from "../src/lib/nearby/also-here";
import { liveEventFor } from "../src/lib/cards/live-event";
import { invalidateHiddenSurfaceKeys, setSurfaceComingSoon } from "../src/lib/surface-visibility";

const PREFIX = "smoke-here-";
const OPERATOR = `${PREFIX}operator`;
const A = `${PREFIX}a`;
const B = `${PREFIX}b`;
const LIVE_ALSO_HERE = "live:feature.also-here";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(eventAliases).where(like(eventAliases.userId, `${PREFIX}%`));
  await db.delete(events).where(like(events.userId, `${PREFIX}%`));
  await db.delete(shareCards).where(like(shareCards.userId, `${PREFIX}%`));
  await db.delete(userSettings).where(like(userSettings.userId, `${PREFIX}%`));
}

/** An owner with a name and a saved (unpaused) card. */
async function seedUser(userId: string, first: string, last: string) {
  const db = await getDb();
  await db.insert(userSettings).values({ userId, firstName: first, lastName: last, email: `${userId}@example.test` });
  await saveCard(userId, { fields: DEFAULT_CARD_FIELDS, phone: null, tagline: null });
}

/** An attended event for `userId` that started `startedMinsAgo` ago, with the given alias keys. */
async function seedEvent(
  userId: string,
  opts: { startedMinsAgo?: number; endsInMins?: number | null; keys?: Array<["provider" | "url" | "source_ref", string]>; title?: string } = {}
): Promise<string> {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(events)
    .values({
      userId,
      title: opts.title ?? "Founders night",
      startsAt: new Date(now - (opts.startedMinsAgo ?? 60) * 60_000),
      endsAt: opts.endsInMins == null ? null : new Date(now + opts.endsInMins * 60_000),
      source: "manual",
    } as typeof events.$inferInsert)
    .returning();
  for (const [kind, value] of opts.keys ?? []) {
    await db.insert(eventAliases).values({ userId, kind, value, eventId: row.id, source: "smoke" });
  }
  return row.id;
}

async function task2() {
  console.log("Task 2 — opt-in store and owner-keyed card read");
  const db = await getDb();
  await seedUser(A, "Ada", "Lovelace");
  await seedUser(B, "Grace", "Hopper");

  check("not findable by default", (await isDiscoverable(A)) === false);
  await setDiscoverable(A, true);
  check("setDiscoverable(true) → findable", (await isDiscoverable(A)) === true);
  await setDiscoverable(A, false);
  check("setDiscoverable(false) → not findable", (await isDiscoverable(A)) === false);

  const bEvent = await seedEvent(B);
  check("hiding at someone else's event is refused", (await setHiddenAtEvent(A, bEvent, true)) === false);
  const [bRow] = await db.select().from(events).where(eq(events.id, bEvent));
  check("…and their event is untouched", bRow.discoveryHiddenAt === null);

  const aEvent = await seedEvent(A);
  check("hiding at your own event works", (await setHiddenAtEvent(A, aEvent, true)) === true);
  const [aRow] = await db.select().from(events).where(eq(events.id, aEvent));
  check("…and sets discovery_hidden_at", aRow.discoveryHiddenAt instanceof Date);
  await setHiddenAtEvent(A, aEvent, false);
  const [aRow2] = await db.select().from(events).where(eq(events.id, aEvent));
  check("unhiding clears it", aRow2.discoveryHiddenAt === null);

  const card = await loadPublicCardForOwner(A);
  check("loadPublicCardForOwner returns the live card", card?.fullName === "Ada Lovelace");
  await setCardPaused(A, true);
  check("…and null once paused", (await loadPublicCardForOwner(A)) === null);
  await setCardPaused(A, false);
}

async function resetEvents() {
  const db = await getDb();
  await db.delete(eventAliases).where(like(eventAliases.userId, `${PREFIX}%`));
  await db.delete(events).where(like(events.userId, `${PREFIX}%`));
}

async function seesB(viewerEvent: string) {
  const r = await alsoHereFor(A, viewerEvent);
  return r.people.some((p) => p.fullName === "Grace Hopper");
}

async function task3() {
  console.log("Task 3 — match people at the same live event");
  const db = await getDb();
  await setDiscoverable(A, true);
  await setDiscoverable(B, true);

  // Same provider key: both see each other; payload is the public card, minus owner id + slug.
  await resetEvents();
  let a = await seedEvent(A, { keys: [["provider", "luma:evt-1"]] });
  let b = await seedEvent(B, { keys: [["provider", "luma:evt-1"]] });
  const ra = await alsoHereFor(A, a);
  check("same luma key → findable", ra.findable === true);
  check("same luma key → A sees exactly B", ra.people.length === 1 && ra.people[0].fullName === "Grace Hopper");
  check("payload has no ownerId or slug", !("ownerId" in ra.people[0]) && !("slug" in ra.people[0]));
  const rb = await alsoHereFor(B, b);
  check("…and B sees A", rb.people.length === 1 && rb.people[0].fullName === "Ada Lovelace");
  await saveCard(B, { fields: { ...DEFAULT_CARD_FIELDS, email: false }, phone: null, tagline: null });
  check("a field B hides is null in A's view", (await alsoHereFor(A, a)).people[0].email === null);
  await saveCard(B, { fields: DEFAULT_CARD_FIELDS, phone: null, tagline: null });

  // URL key shared even though only B has the provider id.
  await resetEvents();
  a = await seedEvent(A, { keys: [["url", "https://luma.com/x"]] });
  b = await seedEvent(B, { keys: [["url", "https://luma.com/x"], ["provider", "luma:evt-1"]] });
  check("shared canonical url → match", await seesB(a));

  // Calendar invite: gcal vs ics, same UID.
  await resetEvents();
  a = await seedEvent(A, { keys: [["source_ref", "gcal:UID-9"]] });
  b = await seedEvent(B, { keys: [["source_ref", "ics:UID-9"]] });
  check("gcal:UID vs ics:UID → match", await seesB(a));
  await resetEvents();
  a = await seedEvent(A, { keys: [["source_ref", "gmail:m1"]] });
  b = await seedEvent(B, { keys: [["source_ref", "gmail:m1"]] });
  check("gmail message ids never match", !(await seesB(a)));

  // Same title and time, nothing shared.
  await resetEvents();
  a = await seedEvent(A, { title: "Demo day", keys: [["provider", "luma:evt-a"]] });
  b = await seedEvent(B, { title: "Demo day", keys: [["provider", "luma:evt-b"]] });
  check("same title + time, no shared key → no match", !(await seesB(a)));

  // Reciprocity.
  await resetEvents();
  a = await seedEvent(A, { keys: [["provider", "luma:evt-1"]] });
  b = await seedEvent(B, { keys: [["provider", "luma:evt-1"]] });
  await setDiscoverable(A, false);
  const notFindable = await alsoHereFor(A, a);
  check("viewer not opted in → findable false, nobody", notFindable.findable === false && notFindable.people.length === 0);
  await setDiscoverable(A, true);
  await setHiddenAtEvent(A, a, true);
  check("viewer hidden here → nobody", (await alsoHereFor(A, a)).people.length === 0);
  await setHiddenAtEvent(A, a, false);

  // Each of B's off-switches.
  await setHiddenAtEvent(B, b, true);
  check("B hidden at the event → absent", !(await seesB(a)));
  await setHiddenAtEvent(B, b, false);
  await setCardPaused(B, true);
  check("B's card paused → absent", !(await seesB(a)));
  await setCardPaused(B, false);
  await setDiscoverable(B, false);
  check("B turned discoverability off → absent", !(await seesB(a)));
  await setDiscoverable(B, true);
  await db.update(userSettings).set({ suspendedAt: new Date() }).where(eq(userSettings.userId, B));
  check("B suspended → absent", !(await seesB(a)));
  await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, B));
  await db.update(events).set({ dismissedAt: new Date() }).where(eq(events.id, b));
  check("B dismissed the event → absent", !(await seesB(a)));
  await db.update(events).set({ dismissedAt: null, roleSource: "inferred", rsvpStatus: "maybe" } as Partial<typeof events.$inferInsert>).where(eq(events.id, b));
  check("B only 'maybe' on a discovered event → absent", !(await seesB(a)));
  await db.update(events).set({ roleSource: null, rsvpStatus: null } as Partial<typeof events.$inferInsert>).where(eq(events.id, b));
  check("B back to attending → present", await seesB(a));

  // Live window.
  await resetEvents();
  a = await seedEvent(A, { keys: [["provider", "luma:evt-1"]] });
  b = await seedEvent(B, { startedMinsAgo: 190, keys: [["provider", "luma:evt-1"]] });
  check("B's event started 3 h 10 min ago, no end → absent", !(await seesB(a)));
  await resetEvents();
  a = await seedEvent(A, { keys: [["provider", "luma:evt-1"]] });
  b = await seedEvent(B, { startedMinsAgo: 60, keys: [["provider", "luma:evt-1"]] });
  check("B's event started 1 h ago → present", await seesB(a));

  // Someone else's event id.
  const other = await alsoHereFor(A, b);
  check("asking about another user's event → findable false, nobody", other.findable === false && other.people.length === 0);

  // Cap at 20.
  await resetEvents();
  a = await seedEvent(A, { keys: [["provider", "luma:big"]] });
  for (let i = 0; i < 25; i++) {
    const u = `${PREFIX}crowd-${String(i).padStart(2, "0")}`;
    await seedUser(u, "Guest", `Number ${String(i).padStart(2, "0")}`);
    await setDiscoverable(u, true);
    await seedEvent(u, { keys: [["provider", "luma:big"]] });
  }
  check("25 matching people → 20 returned", (await alsoHereFor(A, a)).people.length === 20);
}

async function finalReviewFixes() {
  console.log("Final-review fixes");
  const db = await getDb();
  await setDiscoverable(A, true);

  // Fix 1: overlapping live events — the hide control must be reachable on both.
  await resetEvents();
  const conference = await seedEvent(A, { startedMinsAgo: 300, endsInMins: 600, title: "Two-day conference" });
  const session = await seedEvent(A, { startedMinsAgo: 60, title: "Side session" });
  check("liveEventFor picks only the latest-started one", (await liveEventFor(A))?.id === session);
  check("isLiveAttendedEvent: the side session is live", await isLiveAttendedEvent(A, session));
  check("isLiveAttendedEvent: the overlapping conference is live too", await isLiveAttendedEvent(A, conference));
  await db.update(events).set({ dismissedAt: new Date() }).where(eq(events.id, conference));
  check("isLiveAttendedEvent: dismissed → false", !(await isLiveAttendedEvent(A, conference)));
  const bEvent = await seedEvent(B);
  check("isLiveAttendedEvent: someone else's event → false", !(await isLiveAttendedEvent(A, bEvent)));
  const ended = await seedEvent(A, { startedMinsAgo: 400 });
  check("isLiveAttendedEvent: ended (no end, started 6 h 40 min ago) → false", !(await isLiveAttendedEvent(A, ended)));

  // Fix 2: paused cards must not crowd a findable person out of the result.
  await resetEvents();
  const a = await seedEvent(A, { keys: [["provider", "luma:paused-crowd"]] });
  for (let i = 0; i < 60; i++) {
    const u = `${PREFIX}paused-${String(i).padStart(2, "0")}`;
    await seedUser(u, "Paused", `Guest ${String(i).padStart(2, "0")}`);
    await setDiscoverable(u, true);
    await setCardPaused(u, true);
    await seedEvent(u, { keys: [["provider", "luma:paused-crowd"]] });
  }
  const live = `${PREFIX}zz-live`;
  await seedUser(live, "Zed", "Live");
  await setDiscoverable(live, true);
  await seedEvent(live, { keys: [["provider", "luma:paused-crowd"]] });
  const crowd = await alsoHereFor(A, a);
  check("60 discoverable people with paused cards don't hide the one live card", crowd.people.some((p) => p.fullName === "Zed Live"));
  check("…and no paused card is shown", crowd.people.every((p) => p.fullName === "Zed Live"));
}

async function main() {
  await cleanup();
  await setSurfaceComingSoon(OPERATOR, "page.card", false);
  // Features can't be toggled from admin; a `live:` row is what releases one.
  await (await getDb()).insert(appSurfaceFlags).values({ surfaceKey: LIVE_ALSO_HERE, hiddenBy: OPERATOR }).onConflictDoNothing();
  invalidateHiddenSurfaceKeys();
  try {
    await task2();
    await task3();
    await finalReviewFixes();
  } finally {
    await setSurfaceComingSoon(OPERATOR, "page.card", true);
    await (await getDb()).delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, LIVE_ALSO_HERE));
    invalidateHiddenSurfaceKeys();
    await cleanup();
  }
  console.log("\nAll also-here checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
