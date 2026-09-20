/**
 * The people stream: the contact analogue of `ingestEvents`.
 *
 * The three behaviours that matter are matching (a second pass over the same person updates
 * rather than duplicates), enrichment (a record with more fields fills blanks without
 * overwriting what the user typed), and the contact cap (the free plan's limit is enforced
 * here, not at the connector). A fourth is folded in below: two records for the SAME person
 * inside one batch must land on one contact, not two — the in-batch duplicate-index update
 * this module owns.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { openIngestContext, finalizeIngest } from "../src/lib/ingest/events";
import { ingestPeople } from "../src/lib/ingest/people";

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

  await finalizeIngest(ctx);
  await db.delete(contacts).where(eq(contacts.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll people ingest checks passed.");
});
