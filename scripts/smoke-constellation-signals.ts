/**
 * The eligibility tallies as SQL: does the aggregate riding on the closeness cohort's
 * `GROUP BY` actually count what the rule thinks it counts?
 *
 * `smoke-constellation-eligibility.ts` covers the decision given tallies. This covers the
 * tallies themselves, and it exists mostly for one case: **a LinkedIn message must not count
 * as a note.** The import adapter stores each message body in `interactions.raw_notes`, so a
 * "has raw_notes" test — the obvious way to write this — would mark every messaged contact as
 * written-about and quietly turn the entire filter into a no-op. That failure is invisible in
 * the type system and produces no error; only a fixture like this one catches it.
 *
 * Both cohort paths are exercised. They are separate queries in separate branches (stored
 * snapshot vs. freshly built) and it would be easy to add the aggregates to one and not the
 * other, which would make eligibility depend on whether the user's cohort happened to be warm.
 *
 * Run: npx tsx scripts/smoke-constellation-signals.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-signals";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-signals";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { getClosenessCohort } from "../src/lib/closeness-cohort";
import { EMPTY_SIGNAL_COUNTS } from "../src/lib/constellation-eligibility";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-signals-user";

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

async function addContact(fullName: string): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({ userId: USER, fullName })
    .returning({ id: contacts.id });
  return row.id;
}

let externalSeq = 0;
async function log(
  contactId: string,
  interactionType: string,
  extra: { direction?: "in" | "out" | null; rawNotes?: string } = {}
) {
  const db = await getDb();
  await db.insert(interactions).values({
    userId: USER,
    contactId,
    interactionType,
    direction: extra.direction ?? null,
    rawNotes: extra.rawNotes ?? null,
    externalId: `smoke-signal-${externalSeq++}`,
  });
}

run(async () => {
  await reset();

  // The trap: a contact whose only history is imported LinkedIn messages, each carrying its
  // body in raw_notes exactly as the adapter writes them.
  const messagesOnly = await addContact("Messages Only");
  for (let i = 0; i < 4; i++) {
    await log(messagesOnly, "linkedin_message", {
      direction: i % 2 === 0 ? "in" : "out",
      rawNotes: "Body text that lives in raw_notes, like every imported message",
    });
  }

  const noted = await addContact("Written About");
  await log(noted, "note", { rawNotes: "Talked about their new role" });
  await log(noted, "meeting_note", { rawNotes: "Follow-up chat" });

  const met = await addContact("Met In Person");
  await log(met, "in_person");
  await log(met, "meeting");

  const legacy = await addContact("Legacy Import");
  for (let i = 0; i < 7; i++) {
    await log(legacy, "linkedin_message", { rawNotes: "Undirected legacy body" });
  }

  const noisy = await addContact("Cold Outreach");
  await log(noisy, "email", { rawNotes: "Newsletter blast" });
  await log(noisy, "reach_out", { rawNotes: "Sequence step 1" });

  const untouched = await addContact("Never Touched");

  for (const label of ["fresh cohort", "stored cohort"] as const) {
    console.log(`\nTallies from the ${label}…`);
    const cohort = await getClosenessCohort(USER);
    const signals = cohort.constellationSignals;
    const at = (id: string) => signals.get(id) ?? EMPTY_SIGNAL_COUNTS;

    check(
      "an imported LinkedIn message does NOT count as a note",
      at(messagesOnly).noteInteractions === 0,
      `got ${at(messagesOnly).noteInteractions} — raw_notes is being counted`
    );
    check(
      "its messages are counted by direction instead",
      at(messagesOnly).linkedInInbound === 2 && at(messagesOnly).linkedInOutbound === 2,
      JSON.stringify(at(messagesOnly))
    );
    check(
      "note and meeting_note rows both count as notes",
      at(noted).noteInteractions === 2
    );
    check(
      "meeting and in_person both count as meetings",
      at(met).meetingInteractions === 2
    );
    check(
      "undirected message rows are tallied apart from directed ones",
      at(legacy).linkedInUndirected === 7 &&
        at(legacy).linkedInInbound === 0 &&
        at(legacy).linkedInOutbound === 0
    );
    check(
      "email and reach_out are neither notes nor meetings, whatever they carry",
      at(noisy).noteInteractions === 0 && at(noisy).meetingInteractions === 0
    );
    check(
      "a contact with no interactions has no entry and reads as all zeroes",
      !signals.has(untouched) && at(untouched).noteInteractions === 0
    );
    check(
      "tallies do not leak between contacts",
      at(noted).linkedInInbound === 0 && at(messagesOnly).meetingInteractions === 0
    );
  }

  await reset();
  console.log("\nAll constellation signal checks passed.");
});
