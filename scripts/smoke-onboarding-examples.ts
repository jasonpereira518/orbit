/**
 * The guided tour's example people, end to end on PGlite: seeding plants exactly the cast
 * and nothing the plan or the gate can see; removal takes every example row with it — the
 * reminder someone marked done, the note they logged on Maya, a twin a capture created —
 * and leaves every real row alone, including a real person merged with an example either
 * way round. Then a full purge leaves nothing behind.
 *
 * Run: npx tsx scripts/smoke-onboarding-examples.ts
 */
import "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems,
  companies,
  contactBriefs,
  contactIdentities,
  contacts,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import { mergeContacts } from "../src/lib/contact-merge";
import { contactHeadroomForUser, contactUsageForUser } from "../src/lib/contact-writes";
import { needsOnboarding } from "../src/lib/onboarding";
import { EXAMPLE_PEOPLE, TOUR_EXAMPLE_NOTE } from "../src/lib/onboarding-examples/cast";
import { TOUR_EXAMPLE_SOURCE } from "../src/lib/onboarding-examples/marker";
import { removeTourExamples } from "../src/lib/onboarding-examples/remove";
import { seedTourExamples } from "../src/lib/onboarding-examples/seed";
import { countTourExamples } from "../src/lib/onboarding-examples/status";
import { createReminderForUser } from "../src/lib/reminder-writes";
import { purgeUserData } from "../src/lib/user-data";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-onboarding-examples";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function counts() {
  const db = await getDb();
  const n = async (table: typeof contacts | typeof interactions | typeof reminders | typeof actionItems | typeof contactBriefs | typeof contactIdentities) => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.userId, USER));
    return Number(row?.n ?? 0);
  };
  return {
    contacts: await n(contacts),
    interactions: await n(interactions),
    reminders: await n(reminders),
    actionItems: await n(actionItems),
    briefs: await n(contactBriefs),
    identities: await n(contactIdentities),
  };
}

async function exampleIds() {
  const db = await getDb();
  return db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.userId, USER), eq(contacts.source, TOUR_EXAMPLE_SOURCE)));
}

async function main() {
  console.log("Onboarding example people…");
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => null);
  await ensureUserSettings(USER);

  console.log("\nseeding");
  const before = await counts();
  const seeded = await seedTourExamples(USER);
  check("seeds the whole cast", seeded.seeded === EXAMPLE_PEOPLE.length, String(seeded.seeded));
  const after = await counts();
  check("every example contact is marked", (await exampleIds()).length === EXAMPLE_PEOPLE.length);
  check("interactions, briefs, reminders and identities came with them",
    after.interactions > before.interactions && after.briefs === EXAMPLE_PEOPLE.length && after.reminders === 3 && after.identities >= EXAMPLE_PEOPLE.length);
  check("seeding again is a no-op", (await seedTourExamples(USER)).seeded === 0 && (await counts()).contacts === after.contacts);
  check("countTourExamples sees six", (await countTourExamples(USER)) === 6);

  console.log("\na clean removal takes everything back to zero");
  const clean = await removeTourExamples(USER, { since: new Date(Date.now() - 60_000) });
  check("removes all six", clean.removed === 6, String(clean.removed));
  const afterClean = await counts();
  check("no contact, interaction, reminder, brief or identity remains", Object.values(afterClean).every((v) => v === 0), JSON.stringify(afterClean));
  const [castCompanies] = await db.select({ n: sql<number>`count(*)::int` }).from(companies).where(eq(companies.userId, USER));
  check("the cast's companies are gone once nobody works there", Number(castCompanies?.n ?? 0) === 0, String(castCompanies?.n));
  check("countTourExamples is back to zero", (await countTourExamples(USER)) === 0);
  check("removing again removes nothing", (await removeTourExamples(USER, { since: new Date() })).removed === 0);
  await seedTourExamples(USER);

  console.log("\nwhat the examples must not affect");
  const usage = await contactUsageForUser(USER);
  check("the plan's contact usage ignores them", usage.used === 0, String(usage.used));
  const headroom = await contactHeadroomForUser(USER);
  check("headroom is untouched", headroom === null || headroom === usage.limit, String(headroom));
  check("the first-run gate still sees an empty account", await needsOnboarding(USER));

  console.log("\nwhat a person might do during the tour");
  const maya = (await exampleIds()).find((c) => c.fullName.startsWith("Maya"))!;
  const daniel = (await exampleIds()).find((c) => c.fullName.startsWith("Daniel"))!;
  const sofia = (await exampleIds()).find((c) => c.fullName.startsWith("Sofia"))!;
  await db.insert(interactions).values({ userId: USER, contactId: maya.id, interactionType: "note", interactionDate: new Date(), rawNotes: "Practice note on Maya" });
  await createReminderForUser(USER, { contactId: maya.id, title: "Practice reminder" });
  // A real person, and a real person's own reminder.
  const [real] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Real", firstName: "Ada", lastName: "Real" }).returning();
  await createReminderForUser(USER, { contactId: real.id, title: "Real reminder" });
  // A capture that missed the matcher and created an unmarked twin of the example.
  await db.insert(contacts).values({ userId: USER, fullName: "Maya Okonkwo-Reyes", firstName: "Maya", lastName: "Okonkwo-Reyes", notes: TOUR_EXAMPLE_NOTE });
  // Merges either way round.
  const [realWinner] = await db.insert(contacts).values({ userId: USER, fullName: "Bea Winner", source: "linkedin" }).returning();
  await mergeContacts(USER, realWinner.id, daniel.id);
  const [realLoser] = await db.insert(contacts).values({ userId: USER, fullName: "Cal Loser", source: "linkedin" }).returning();
  await mergeContacts(USER, sofia.id, realLoser.id);
  const winnerRow = await db.query.contacts.findFirst({ where: eq(contacts.id, realWinner.id), columns: { source: true } });
  check("a real winner keeps its own source after absorbing an example", winnerRow?.source === "linkedin", String(winnerRow?.source));
  const sofiaRow = await db.query.contacts.findFirst({ where: eq(contacts.id, sofia.id), columns: { source: true } });
  check("an example that absorbs a real person stops being an example", sofiaRow?.source !== TOUR_EXAMPLE_SOURCE, String(sofiaRow?.source));

  console.log("\nremoval");
  const settingsRow = await ensureUserSettings(USER);
  const since = new Date(Date.now() - 60_000);
  void settingsRow;
  const removed = await removeTourExamples(USER, { since });
  check("removes the remaining examples and the twin", removed.removed === 5, String(removed.removed));
  const left = await db.select({ id: contacts.id, fullName: contacts.fullName, source: contacts.source }).from(contacts).where(eq(contacts.userId, USER));
  const names = left.map((c) => c.fullName).sort();
  check("the real people survive: Ada, Bea (winner) and Sofia (now real)", names.join(",") === ["Ada Real", "Bea Winner", "Sofia Marchetti"].join(","), names.join(","));
  check("no example marker is left anywhere", left.every((c) => c.source !== TOUR_EXAMPLE_SOURCE));
  const rem = (await db.select({ title: reminders.title }).from(reminders).where(eq(reminders.userId, USER))).map((r) => r.title);
  check("the practice reminder went with Maya", !rem.includes("Practice reminder"), rem.join(","));
  check("the real reminder stays", rem.includes("Real reminder"), rem.join(","));
  // Daniel's reminder was repointed to Bea by the merge and Sofia is real now: both stay,
  // because the person chose to keep that data when they merged.
  check("reminders adopted through a merge stay with their real owner", rem.includes("Call Daniel about the API pilot") && rem.includes("Share the traction update with Sofia"), rem.join(","));
  const notes = await db.select({ id: interactions.id }).from(interactions).where(and(eq(interactions.userId, USER), eq(interactions.contactId, maya.id)));
  check("the practice note is gone", notes.length === 0);
  const orphaned = await db.execute(sql`SELECT count(*)::int AS n FROM ${companies} co WHERE co.user_id = ${USER} AND NOT EXISTS (SELECT 1 FROM ${contacts} c WHERE c.company_id = co.id)`);
  check("no cast company is left without a contact", Number((orphaned.rows?.[0] as { n?: number } | undefined)?.n ?? 0) === 0);
  check("countTourExamples is back to zero", (await countTourExamples(USER)) === 0);
  check("removing again removes nothing", (await removeTourExamples(USER, { since })).removed === 0);

  console.log("\na full purge leaves nothing");
  await seedTourExamples(USER);
  await purgeUserData(USER, { keepSettings: false });
  const end = await counts();
  check("no contact, interaction, reminder, brief or identity remains", Object.values(end).every((v) => v === 0), JSON.stringify(end));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  console.log("\nAll onboarding example checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
