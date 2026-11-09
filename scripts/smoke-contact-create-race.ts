/**
 * Concurrent contact writes (audit M-13): the free plan's cap, two creates of one person,
 * and two saves merging facts and tags into one contact. Each used to be read-then-write.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-contact-create-race.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contactIdentities, contacts, userSettings } from "../src/db/schema";
import { addTagsForUser, createContactForUser, updateContactForUser } from "../src/lib/contact-writes";
import { FREE_CONTACT_LIMIT } from "../src/lib/plans/plan-config";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-contact-create-race";
const W = { skipEmbedding: true, skipRevalidate: true, skipSummary: true, skipCloseness: true } as const;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

run(async () => {
  const db = await getDb();
  await reset();

  console.log("The free plan's cap under concurrency...");
  const filler = Array.from({ length: FREE_CONTACT_LIMIT - 1 }, (_, i) => ({ userId: USER, fullName: `Filler ${i}` }));
  for (let i = 0; i < filler.length; i += 200) await db.insert(contacts).values(filler.slice(i, i + 200));
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => createContactForUser(USER, { fullName: `Racer ${i}` }, W))
  );
  const created = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.filter((r) => r.status === "rejected" && (r.reason as Error).name === "PaywallError").length;
  const [{ n }] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE user_id = ${USER}`));
  check("exactly one of twenty racers fits the last slot", created === 1, `${created} created`);
  check("the rest get the paywall, not a crash", refused === 19, `${refused} refused`);
  check("the account sits exactly at the cap", Number(n) === FREE_CONTACT_LIMIT, String(n));
  check(
    "a create at the cap is still refused afterwards",
    await createContactForUser(USER, { fullName: "One more" }, W).then(() => false, (e) => (e as Error).name === "PaywallError")
  );

  console.log("\nTwo creates of the same person...");
  await reset();
  const same = { fullName: "Same Person", email: "same.person@example.com" };
  const [a, b] = await Promise.all([createContactForUser(USER, same, W), createContactForUser(USER, same, W)]);
  const rows = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, USER));
  const idents = await db.select().from(contactIdentities).where(eq(contactIdentities.userId, USER));
  check("one contact remains", rows.length === 1, `${rows.length} contacts`);
  check("both callers are handed the survivor", a.id === rows[0]?.id && b.id === rows[0]?.id, `${a.id} ${b.id} ${rows[0]?.id}`);
  check("its identity row points at it", idents.length === 1 && idents[0]!.contactId === rows[0]?.id);

  console.log("\nTwo merges writing key facts at once...");
  await reset();
  const target = await createContactForUser(USER, { fullName: "Merge Target", keyFacts: ["Existing fact"] }, W);
  await Promise.all([
    updateContactForUser(USER, target.id, { keyFacts: ["Existing fact", "From capture A"] }, { ...W, mergeFactLists: true }),
    updateContactForUser(USER, target.id, { keyFacts: ["Existing fact", "From capture B"] }, { ...W, mergeFactLists: true }),
  ]);
  const [merged] = await db.select({ keyFacts: contacts.keyFacts }).from(contacts).where(eq(contacts.id, target.id));
  check(
    "both captures' facts survive, the existing one first, nothing doubled",
    JSON.stringify(merged?.keyFacts?.slice(0, 1)) === JSON.stringify(["Existing fact"]) &&
      merged?.keyFacts?.includes("From capture A") === true &&
      merged?.keyFacts?.includes("From capture B") === true &&
      merged?.keyFacts?.length === 3,
    JSON.stringify(merged?.keyFacts)
  );
  await updateContactForUser(USER, target.id, { keyFacts: ["  existing   FACT ", ""] }, { ...W, mergeFactLists: true });
  const [again] = await db.select({ keyFacts: contacts.keyFacts }).from(contacts).where(eq(contacts.id, target.id));
  check("a case/whitespace variant of an existing fact is not added again", again?.keyFacts?.length === 3, JSON.stringify(again?.keyFacts));
  await updateContactForUser(USER, target.id, { keyFacts: Array.from({ length: 60 }, (_, i) => `Fact ${i}`) }, { ...W, mergeFactLists: true });
  const [capped] = await db.select({ keyFacts: contacts.keyFacts }).from(contacts).where(eq(contacts.id, target.id));
  check("the merged list is capped, existing entries kept first", (capped?.keyFacts?.length ?? 0) === 24 && capped?.keyFacts?.[0] === "Existing fact", String(capped?.keyFacts?.length));

  console.log("\nAdding tags never removes one...");
  await updateContactForUser(USER, target.id, { tagNames: ["founder"] }, W);
  await Promise.all([addTagsForUser(USER, target.id, ["climate"]), addTagsForUser(USER, target.id, ["fintech"])]);
  const tagRows = rowsOf<{ name: string }>(
    await db.execute(sql`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ${target.id}::uuid ORDER BY t.name`)
  );
  check("both concurrent additions and the existing tag are present", tagRows.map((r) => r.name).join() === "climate,fintech,founder", tagRows.map((r) => r.name).join());
  await addTagsForUser(USER, target.id, ["founder"]);
  const after = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = ${target.id}::uuid`));
  check("re-adding an existing tag adds no second link", Number(after[0]?.n) === 3, String(after[0]?.n));
  await addTagsForUser("someone-else", target.id, ["intruder"]);
  const afterForeign = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = ${target.id}::uuid`));
  check("another account cannot tag this contact", Number(afterForeign[0]?.n) === 3, String(afterForeign[0]?.n));

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll concurrent contact-write checks passed.");
});
