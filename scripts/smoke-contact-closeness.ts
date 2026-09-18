/**
 * `getContactCloseness` (the contact page's one-round-trip read) must say exactly what
 * `getClosenessCohort` (the whole-network read it replaced there) says about that contact:
 * the same score, the same recent-touch count, the same constellation tallies. A drift here
 * would show a person one closeness on their profile and another in the list, with nothing
 * failing — the profile would simply be wrong.
 *
 * Also pins the fallback: a contact that has never been scored must take the whole-network
 * path, not render a closeness of zero from a missing row. And the dashboard's slim read
 * (`getClosenessCohortSlim`) must carry exactly the full read's four whole-network numbers.
 *
 * Run: npx tsx scripts/smoke-contact-closeness.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import {
  getClosenessCohort,
  getClosenessCohortSlim,
  getContactCloseness,
  recalibrateCloseness,
} from "../src/lib/closeness-cohort";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-contact-closeness-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function addContact(fullName: string, company: string | null = null): Promise<string> {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId: USER, fullName, company }).returning();
  return row.id;
}

let seq = 0;
async function log(contactId: string, interactionType: string, daysAgo: number) {
  const db = await getDb();
  await db.insert(interactions).values({
    userId: USER,
    contactId,
    interactionType,
    interactionDate: new Date(Date.now() - daysAgo * 86_400_000),
    externalId: `smoke-contact-closeness-${seq++}`,
  });
}

run(async () => {
  await reset();

  // A spread of relationships, so the distribution has real quantiles to place people in.
  const close = await addContact("Close Friend", "Acme");
  for (const d of [1, 3, 8, 15, 30]) await log(close, "meeting", d);
  await log(close, "note", 2);
  const colleague = await addContact("Colleague", "Acme");
  await log(colleague, "linkedin_message", 5);
  await log(colleague, "email", 40);
  const distant = await addContact("Old Contact", "Globex");
  await log(distant, "email", 300);
  await addContact("Never Touched", null);

  await recalibrateCloseness(USER);

  // Outside a request `cache()` is a pass-through, so each call below is a fresh read.
  const whole = await getClosenessCohort(USER);
  for (const [label, id] of [
    ["close", close],
    ["colleague", colleague],
    ["distant", distant],
  ] as const) {
    const one = await getContactCloseness(USER, id);
    check(`${label}: single read returns only that contact`, one.byId.size === 1);
    check(
      `${label}: same score as the whole-network read`,
      JSON.stringify(one.byId.get(id)) === JSON.stringify(whole.byId.get(id)),
      `${JSON.stringify(one.byId.get(id))} vs ${JSON.stringify(whole.byId.get(id))}`
    );
    check(
      `${label}: same recent-touch count`,
      (one.touchCounts.get(id) ?? 0) === (whole.touchCounts.get(id) ?? 0)
    );
    check(
      `${label}: same constellation tallies`,
      JSON.stringify(one.constellationSignals.get(id)) ===
        JSON.stringify(whole.constellationSignals.get(id))
    );
    check(`${label}: same goals`, JSON.stringify(one.goals) === JSON.stringify(whole.goals));
  }

  // The dashboard's slim read: the same four numbers, exactly, for every contact — it
  // extracts them from the stored breakdown rather than reading the rounded columns.
  const slim = await getClosenessCohortSlim(USER);
  check("slim read covers the same contacts", slim.byId.size === whole.byId.size);
  for (const [id, full] of whole.byId) {
    const lean = slim.byId.get(id);
    check(
      `slim matches full for ${id.slice(0, 8)}`,
      !!lean &&
        lean.raw === full.raw &&
        lean.closeness === full.closeness &&
        lean.orbitScore === full.orbitScore &&
        lean.tier === full.tier,
      `${JSON.stringify(lean)} vs raw=${full.raw} closeness=${full.closeness} orbit=${full.orbitScore} tier=${full.tier}`
    );
  }
  check(
    "slim read carries the same constellation tallies",
    JSON.stringify([...slim.constellationSignals]) === JSON.stringify([...whole.constellationSignals])
  );
  check("slim read carries the same average", slim.averageRaw === whole.averageRaw);

  // An unscored contact (created after the last recalibration) must fall back to the
  // whole-network path — which scores it — rather than read a missing breakdown as zero.
  const late = await addContact("Added Later", "Initech");
  const db = await getDb();
  await db.execute(
    sql`update contacts set closeness_breakdown = null, closeness_computed_at = null where id = ${late}`
  );
  const fallback = await getContactCloseness(USER, late);
  check(
    "an unscored contact falls back to the whole-network read",
    fallback.byId.size > 1 && fallback.byId.has(late),
    `byId size ${fallback.byId.size}`
  );

  await reset();
});
