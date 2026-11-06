/**
 * The people stream: the contact analogue of `ingestEvents`.
 *
 * The three behaviours that matter are matching (a second pass over the same person updates
 * rather than duplicates), enrichment (a record with more fields fills blanks without
 * overwriting what the user typed), and the contact cap (the free plan's limit is enforced
 * here, not at the connector). A fourth is folded in below: two records for the SAME person
 * inside one batch must land on one contact, not two — the in-batch duplicate-index update
 * this module owns. A fifth checks that `notes` (needed for P1's iCloud CardDAV sync, which
 * carries a per-contact NOTE field) reaches the row on create, and documents what happens
 * to it on the merge path.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { closenessCohorts, contacts, contactTags, tags } from "../src/db/schema";
import { openIngestContext, finalizeIngest } from "../src/lib/ingest/events";
import { completenessScore, ingestPeople } from "../src/lib/ingest/people";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-ingest-people";

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const ctx = await openIngestContext(USER, { source: "smoke", createsContacts: true });

  console.log("first pass creates");
  const first = await ingestPeople(ctx, [
    { fullName: "Ada Lovelace", email: "ada@example.com", company: "Analytical" },
    { fullName: "Grace Hopper", email: "grace@example.com" },
  ]);
  check("two people created", first.created === 2, JSON.stringify(first));
  check("nothing matched on an empty workspace", first.matched === 0);

  console.log("\nsecond pass matches and enriches");
  const second = await ingestPeople(ctx, [
    { fullName: "Ada Lovelace", email: "ada@example.com", title: "Mathematician" },
  ]);
  check("the same person matched", second.matched === 1, JSON.stringify(second));
  check("no duplicate was created", second.created === 0);

  const [ada] = await db.select().from(contacts).where(eq(contacts.email, "ada@example.com"));
  check("the blank field was filled", ada?.title === "Mathematician");
  check("the existing field was kept", ada?.company === "Analytical");

  const all = await db.select().from(contacts).where(eq(contacts.userId, USER));
  check("still two contacts in total", all.length === 2, String(all.length));

  console.log("\nthird pass: two records for the same NEW person in one batch");
  const third = await ingestPeople(ctx, [
    { fullName: "Alan Turing", email: "alan@example.com", company: "Bletchley" },
    { fullName: "Alan Turing", email: "alan@example.com", title: "Cryptanalyst" },
  ]);
  check(
    "only one contact created for the repeated person",
    third.created === 1,
    JSON.stringify(third)
  );
  check(
    "the repeat folded in-batch rather than matching an existing contact",
    third.matched === 0,
    JSON.stringify(third)
  );

  const alanRows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, "alan@example.com"));
  check("exactly one Alan Turing contact exists", alanRows.length === 1, String(alanRows.length));
  check(
    "the two in-batch rows folded into one another (company from the first, title from the second)",
    alanRows[0]?.company === "Bletchley" && alanRows[0]?.title === "Cryptanalyst",
    JSON.stringify(alanRows[0])
  );

  console.log("\nfourth pass: the plan's contact cap is enforced here");
  const capped = await openIngestContext(USER, { source: "smoke", createsContacts: true });
  capped.headroom = 0;
  const fourth = await ingestPeople(capped, [
    { fullName: "Brand New Person", email: "brandnew@example.com" },
  ]);
  check("blocked by the plan cap rather than created", fourth.created === 0 && fourth.blockedByPlan === 1, JSON.stringify(fourth));
  const blockedRows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, "brandnew@example.com"));
  check("the capped person was not written", blockedRows.length === 0);

  console.log("\nfifth pass: the cap can bite part-way through a single batch");
  const partial = await openIngestContext(USER, { source: "smoke", createsContacts: true });
  partial.headroom = 1;
  const fifth = await ingestPeople(partial, [
    { fullName: "Partial One", email: "partial1@example.com" },
    { fullName: "Partial Two", email: "partial2@example.com" },
  ]);
  check(
    "exactly one created, one blocked, when the cap bites mid-batch",
    fifth.created === 1 && fifth.blockedByPlan === 1,
    JSON.stringify(fifth)
  );

  console.log("\nsixth pass: notes are carried through on create");
  const sixth = await ingestPeople(ctx, [
    {
      fullName: "Marie Curie",
      email: "marie@example.com",
      notes: "Met at a conference in Paris.",
    },
  ]);
  check("the person with notes was created", sixth.created === 1, JSON.stringify(sixth));
  const [marie] = await db.select().from(contacts).where(eq(contacts.email, "marie@example.com"));
  check(
    "the note was written to the new contact",
    marie?.notes === "Met at a conference in Paris.",
    JSON.stringify(marie?.notes)
  );

  console.log("\nseventh pass: a note on a MATCHED (merged) record — bulkMergeContactsForUser");
  console.log("does not include `notes` in its UPDATE column list, so this is a documented no-op,");
  console.log("not an overwrite and not a clear — the pre-existing note must survive unchanged.");
  const seventh = await ingestPeople(ctx, [
    {
      fullName: "Marie Curie",
      email: "marie@example.com",
      notes: "A different note that should NOT land.",
      title: "Physicist",
    },
  ]);
  check("the second record matched rather than created a duplicate", seventh.matched === 1);
  const [marieAgain] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, "marie@example.com"));
  check(
    "an ordinary blank field (title) still fills on merge",
    marieAgain?.title === "Physicist",
    String(marieAgain?.title)
  );
  check(
    "the original note survived untouched — merge does not write notes at all",
    marieAgain?.notes === "Met at a conference in Paris.",
    JSON.stringify(marieAgain?.notes)
  );

  console.log("\neighth pass: `tagNames` tags people this run CREATES, and only those");
  console.log("A synced address book must land on the default sky the way a one-time import does:");
  console.log("the batch adapters tag their people, and a tag is an intent signal.");
  const tagged = await openIngestContext(USER, {
    source: "smoke",
    createsContacts: true,
    tagNames: ["google-contacts"],
  });
  const eighth = await ingestPeople(tagged, [
    { fullName: "Katherine Johnson", email: "katherine@example.com" },
    // Already exists (created untagged in the first pass) — a merge must not tag it.
    { fullName: "Grace Hopper", email: "grace@example.com", title: "Rear Admiral" },
  ]);
  check("one created, one matched", eighth.created === 1 && eighth.matched === 1, JSON.stringify(eighth));

  const tagNamesFor = async (email: string) => {
    const [contact] = await db.select().from(contacts).where(eq(contacts.email, email));
    if (!contact) return null;
    const rows = await db
      .select({ name: tags.name })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(eq(contactTags.contactId, contact.id));
    return rows.map((r) => r.name);
  };
  const katherineTags = await tagNamesFor("katherine@example.com");
  check(
    "the newly created person carries the source tag",
    JSON.stringify(katherineTags) === JSON.stringify(["google-contacts"]),
    JSON.stringify(katherineTags)
  );
  const graceTags = await tagNamesFor("grace@example.com");
  check(
    "the matched (pre-existing) person was not tagged",
    Array.isArray(graceTags) && graceTags.length === 0,
    JSON.stringify(graceTags)
  );

  console.log("\nninth pass: `recalibrate` scores the network now, the default leaves it dirty");
  console.log("Only the run that finishes a first full read asks for it; a delta run relies on the");
  console.log("debounce so a sync storm cannot become a recalibration storm.");
  const cohortRow = async () =>
    (await db.select().from(closenessCohorts).where(eq(closenessCohorts.userId, USER)))[0];
  await db.delete(closenessCohorts).where(eq(closenessCohorts.userId, USER));
  const debounced = await openIngestContext(USER, { source: "smoke", createsContacts: true });
  await ingestPeople(debounced, [{ fullName: "Dorothy Vaughan", email: "dorothy@example.com" }]);
  await finalizeIngest(debounced);
  const afterDefault = await cohortRow();
  check(
    "by default the cohort is only marked dirty",
    !!afterDefault?.dirtyAt && afterDefault.contactCount === 0,
    JSON.stringify({ dirtyAt: afterDefault?.dirtyAt, n: afterDefault?.contactCount })
  );

  const total = (await db.select().from(contacts).where(eq(contacts.userId, USER))).length;
  await finalizeIngest(debounced, { recalibrate: true });
  const afterRecalibrate = await cohortRow();
  check(
    "with `recalibrate` it is computed over the whole network and no longer dirty",
    afterRecalibrate?.dirtyAt === null && afterRecalibrate?.contactCount === total,
    JSON.stringify({ dirtyAt: afterRecalibrate?.dirtyAt, n: afterRecalibrate?.contactCount, total })
  );

  console.log("\ntenth pass: when the cap bites, the best-described people are the ones kept");
  const rankedCtx = await openIngestContext(USER, { source: "smoke", createsContacts: true });
  rankedCtx.headroom = 2;
  const tenth = await ingestPeople(rankedCtx, [
    // Listed FIRST, but a bare name is the weakest thing in an address book.
    { fullName: "Bare Name" },
    { fullName: "Some Email", email: "someemail@example.com" },
    { fullName: "Full Record", email: "full@example.com", phone: "+1 555 0100", company: "Acme", title: "CTO" },
    // The same person twice while capped: must count as ONE blocked person, not two.
    { fullName: "Bare Name" },
  ]);
  check("two created, one blocked (the repeat folded rather than counting twice)", tenth.created === 2 && tenth.blockedByPlan === 1, JSON.stringify(tenth));
  const keptNames = (
    await db.select().from(contacts).where(eq(contacts.userId, USER))
  ).map((c) => c.fullName);
  check("the full record was kept", keptNames.includes("Full Record"), JSON.stringify(keptNames));
  check("the email-only record was kept", keptNames.includes("Some Email"));
  check("the bare name, though listed first, was the one held back", !keptNames.includes("Bare Name"));
  check(
    "any contact detail outranks a bare name, and a way to reach someone outranks a workplace alone",
    completenessScore({ fullName: "A", email: "a@b.c" }) > completenessScore({ fullName: "A" }) &&
      completenessScore({ fullName: "A", linkedinUrl: "https://linkedin.com/in/a" }) >
        completenessScore({ fullName: "A", company: "X" })
  );

  await finalizeIngest(ctx);
  await db.delete(contacts).where(eq(contacts.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll people ingest checks passed.");
});
