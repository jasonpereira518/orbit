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
import { closenessCohorts, contacts, interactions, userSettings } from "../src/db/schema";
import { rescoreContact } from "../src/lib/closeness-materialize";
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

  console.log("\ndeep read: closeness from LinkedIn evidence");
  await reset();
  const dbx = await getDb();
  await dbx.update(userSettings).set({
    careerProfile: { positions: [{ title: "Engineer", company: "Acme", start: { year: 2021 }, end: { year: 2023 } }] },
  }).where(eq(userSettings.userId, USER));
  const friend = await addContact("Old Friend", null);
  let k = 0;
  for (const year of [2019, 2020, 2021, 2022]) {
    for (const direction of ["in", "out"] as const) {
      await dbx.insert(interactions).values({
        userId: USER, contactId: friend, interactionType: "linkedin_message", direction,
        interactionDate: new Date(Date.UTC(year, 5, 1 + k)), externalId: `deep-close-${k++}`, rawNotes: "hello",
      });
    }
  }
  await dbx.insert(interactions).values({
    userId: USER, contactId: friend, interactionType: "note", source: "linkedin_export",
    interactionDate: new Date(Date.UTC(2022, 8, 1)), externalId: `li-export:recommendation_received:k1:${friend}`, rawNotes: "Recommended you on LinkedIn:\nGreat engineer.",
  });
  const oneOff = await addContact("One Off", null);
  await dbx.insert(interactions).values({
    userId: USER, contactId: oneOff, interactionType: "linkedin_message", direction: "in",
    interactionDate: new Date(Date.now() - 20 * 86_400_000), externalId: `deep-close-${k++}`, rawNotes: "hi there",
  });
  // What the messages importer stamps; inserting interaction rows directly does not.
  await dbx.update(contacts).set({ firstInteractionAt: new Date(Date.UTC(2019, 5, 1)), lastInteractionAt: new Date(Date.UTC(2022, 8, 1)) }).where(eq(contacts.id, friend));
  await dbx.update(contacts).set({ firstInteractionAt: new Date(Date.now() - 20 * 86_400_000), lastInteractionAt: new Date(Date.now() - 20 * 86_400_000) }).where(eq(contacts.id, oneOff));
  const acme = await addContact("Acme Colleague", "Acme");
  await addContact("Stranger", "Globex");

  const stored = async (id: string) => {
    const row = await dbx.query.contacts.findFirst({ where: eq(contacts.id, id), columns: { closenessRaw: true } });
    return row ? { raw: row.closenessRaw ?? Number.NaN } : null;
  };
  const off1 = await recalibrateCloseness(USER, { deepRead: false });
  const offFriend = off1.byId.get(friend)!.raw;
  const deep = await recalibrateCloseness(USER, { deepRead: true });
  check("deep read: the old two-way friend outranks the recent one-off", deep.byId.get(friend)!.raw > deep.byId.get(oneOff)!.raw,
    `${deep.byId.get(friend)!.raw} vs ${deep.byId.get(oneOff)!.raw}`);
  check("deep read: a real shared employer lifts a never-messaged colleague's prior", deep.byId.get(acme)!.prior > off1.byId.get(acme)!.prior,
    `${deep.byId.get(acme)!.prior} vs ${off1.byId.get(acme)!.prior}`);
  const snap = await dbx.query.closenessCohorts.findFirst({ where: eq(closenessCohorts.userId, USER) });
  check("the stored snapshot says deep read was on", snap?.snapshot.deepRead === true);
  const before = (await stored(friend))!.raw;
  await rescoreContact(USER, friend);
  check("a single rescore agrees with the cohort", Math.abs((await stored(friend))!.raw - before) < 1e-9, `${(await stored(friend))?.raw} vs ${before}`);
  const off2 = await recalibrateCloseness(USER, { deepRead: false });
  check("deep read off gives today's scores again", Math.abs(off2.byId.get(friend)!.raw - offFriend) < 1e-9);
  await rescoreContact(USER, friend);
  // closeness_raw is a float4: compared with a full-precision number, it agrees to ~7 digits.
  check("a single rescore after an off pass gives the off score", Math.abs((await stored(friend))!.raw - offFriend) < 1e-6, `${(await stored(friend))?.raw} vs ${offFriend}`);

  await reset();
});
