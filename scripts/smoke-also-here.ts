/**
 * Also here (people at the same event), end to end against a throwaway PGlite. One section per task.
 *
 * Run: npx tsx scripts/smoke-also-here.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { eventAliases, events, shareCards, userSettings } from "../src/db/schema";
import { DEFAULT_CARD_FIELDS, loadPublicCardForOwner, saveCard, setCardPaused } from "../src/lib/cards/card-store";
import { isDiscoverable, setDiscoverable, setHiddenAtEvent } from "../src/lib/nearby/discoverability";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";

const PREFIX = "smoke-here-";
const OPERATOR = `${PREFIX}operator`;
const A = `${PREFIX}a`;
const B = `${PREFIX}b`;

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

async function main() {
  await cleanup();
  await setSurfaceComingSoon(OPERATOR, "page.card", false);
  try {
    await task2();
  } finally {
    await setSurfaceComingSoon(OPERATOR, "page.card", true);
    await cleanup();
  }
  console.log("\nAll also-here checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
