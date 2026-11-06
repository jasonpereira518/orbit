/**
 * The chat shape lanes (`src/lib/chat-lanes.ts`) and the exhaustive listing under them
 * (`listContactsMatching` in `src/lib/hybrid-search.ts`):
 *
 *  - a list question returns EVERYONE matching, past the 12 a relevance rank keeps, with an
 *    exact total even when the listing is capped;
 *  - a count question's time window counts each person once, from logged interactions;
 *  - "quiet since" means in touch before the day and never after;
 *  - another user's contacts never appear;
 *  - a name resolves to one contact, stays unresolved when ambiguous or unknown.
 *
 * Runs against a throwaway PGlite database (keyword search; no AI key, no pgvector).
 * Run: npx tsx scripts/smoke-chat-lanes.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { listContactsMatching, CONTACT_LISTING_CAP } from "../src/lib/hybrid-search";
import { filterLane, matchContactsByName, personLane } from "../src/lib/chat-lanes";
import { sanitizeParsedQuery } from "../src/lib/chat-retrieval";
import { NULL_STEPS } from "../src/lib/chat-steps";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-chat-lanes-user";
const OTHER = "smoke-chat-lanes-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

async function clear() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
}

async function main() {
  await clear();
  await ensureUserSettings(USER);
  const db = await getDb();

  // 30 Duke alumni, 210 at Acme, and one Duke alum who belongs to someone else.
  const duke = await db
    .insert(contacts)
    .values(Array.from({ length: 30 }, (_, i) => ({ userId: USER, fullName: `Duke Person ${i}`, school: "Duke University" })))
    .returning();
  await db
    .insert(contacts)
    .values(Array.from({ length: 210 }, (_, i) => ({ userId: USER, fullName: `Other Person ${i}`, company: "Acme" })));
  await db.insert(contacts).values({ userId: OTHER, fullName: "Not Yours", school: "Duke University" });

  console.log("list");
  const list = await listContactsMatching(USER, { filters: { schools: ["Duke"] } });
  check("every Duke alum, past the 12 a rank keeps", list?.total === 30 && list.people.length === 30, list?.total);
  check("exactly the Duke alumni", list?.people.every((p) => duke.some((d) => d.id === p.id)) === true);
  check("never another user's contact", list?.people.every((p) => p.name !== "Not Yours") === true);
  const all = await listContactsMatching(USER, { filters: { companies: ["Acme"] }, limit: 500 });
  check("a listing is capped at 200, the total is not", all?.total === 210 && all.people.length === 200 && all.truncated, all?.total);
  const everyone = await listContactsMatching(USER, { filters: { schools: ["Duke"], companies: [] }, limit: 10 });
  check("past the cap it says it was truncated", everyone?.people.length === 10 && everyone.truncated && everyone.total === 30);
  check("the cap is 200", CONTACT_LISTING_CAP === 200);
  check("nothing to narrow by → no listing (not the whole network)", (await listContactsMatching(USER, {})) === null);

  console.log("\ntime windows");
  const [a, b, c] = duke;
  await db.insert(interactions).values([
    // a: twice in September → counted once.
    { userId: USER, contactId: a!.id, interactionType: "meeting", interactionDate: new Date("2026-09-03T15:00:00Z") },
    { userId: USER, contactId: a!.id, interactionType: "call", interactionDate: new Date("2026-09-20T15:00:00Z") },
    // b: the last day of September, late in the UTC day → inside an inclusive "before".
    { userId: USER, contactId: b!.id, interactionType: "meeting", interactionDate: new Date("2026-09-30T23:30:00Z") },
    // c: June only → quiet since July.
    { userId: USER, contactId: c!.id, interactionType: "meeting", interactionDate: new Date("2026-06-10T15:00:00Z") },
  ]);
  const sept = await listContactsMatching(USER, { window: { mode: "interacted", after: "2026-09-01", before: "2026-09-30" } });
  check("met in September: two people, each once", sept?.total === 2, sept);
  check("with the day they were last in touch", sept?.people.find((p) => p.id === a!.id)?.lastInteraction === "2026-09-20");
  const quiet = await listContactsMatching(USER, { window: { mode: "quiet", after: "2026-07-01" } });
  check("quiet since July: only the June contact", quiet?.total === 1 && quiet.people[0]?.id === c!.id, quiet);
  const dukeQuiet = await listContactsMatching(USER, {
    filters: { schools: ["Duke"] },
    window: { mode: "interacted", after: "2026-09-01" },
  });
  check("filters and a window combine", dukeQuiet?.total === 2);

  console.log("\nfilter lane");
  const parsed = sanitizeParsedQuery({ shape: "list", filters: { schools: ["Duke"] }, intent: {} }, "Everyone from Duke");
  const roster = await filterLane(USER, parsed, NULL_STEPS);
  check("a list question becomes a complete roster", roster?.kind === "filter" && roster.total === 30 && !roster.truncated, roster?.name);
  check("named after what it filtered", roster?.name === "Contacts matching schools: Duke");
  check(
    "an open question runs no lane",
    (await filterLane(USER, sanitizeParsedQuery({ shape: "open", filters: { schools: ["Duke"] } }, "q"), NULL_STEPS)) === null
  );
  check(
    "a list with nothing to filter runs no lane",
    (await filterLane(USER, sanitizeParsedQuery({ shape: "list" }, "q"), NULL_STEPS)) === null
  );
  const count = await filterLane(
    USER,
    sanitizeParsedQuery({ shape: "count", time: { mode: "interacted", after: "2026-09-01", before: "2026-09-30" } }, "q"),
    NULL_STEPS
  );
  check("a count question's roster carries the exact count", count?.total === 2, count);

  console.log("\nnames");
  await db.insert(contacts).values([
    { userId: USER, fullName: "James Okafor", company: "Northwind" },
    { userId: USER, fullName: "Priya Raman", company: "Stripe" },
    { userId: USER, fullName: "Sam Lee", company: "Ramp" },
    { userId: USER, fullName: "Sam Patel", company: "Figma" },
  ]);
  const priya = await matchContactsByName(USER, "Priya");
  check("a first name is a strong match", priya.strong.length === 1 && priya.strong[0]!.name === "Priya Raman", priya);
  const jim = await matchContactsByName(USER, "Jim Okafor");
  check("a misspelled first name still matches on the surname (weak)", jim.strong.length === 0 && jim.weak.some((p) => p.name === "James Okafor"), jim);

  const lane = (person: string) => personLane(USER, sanitizeParsedQuery({ shape: "person", person }, "q"), NULL_STEPS);
  check("one match resolves", (await lane("Priya Raman"))?.name === "Priya Raman");
  check("a weak match alone resolves", (await lane("Jim Okafor"))?.name === "James Okafor");
  check("two people named Sam stay unresolved", (await lane("Sam")) === null);
  check("no one by that name stays unresolved", (await lane("Zelda Quark")) === null);

  await clear();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat lane checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
