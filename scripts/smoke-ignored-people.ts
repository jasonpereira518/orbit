/**
 * The set-aside list: one row per name, the latest capture's context wins, a name that
 * becomes a contact drops off, and "Add as contact" goes through the shared funnel.
 * Absorbs the unresolved-mentions checks that used to live in smoke-note-batch.
 *
 * Run: npx tsx scripts/smoke-ignored-people.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-ignored-people";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-ignored-people";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, ignoredPeople, userSettings } from "../src/db/schema";
import {
  countIgnoredPeopleFor,
  listIgnoredPeopleFor,
  normalizePersonKey,
  promoteIgnoredPerson,
  removeIgnoredPerson,
  upsertIgnoredPeople,
} from "../src/lib/ignored-people";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-ignored-people-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  check("keys normalize case and whitespace", normalizePersonKey("  Priya   Nair ") === "priya nair");

  const n = await upsertIgnoredPeople(USER, [
    { displayName: "Priya Nair", reason: "mentioned", context: "runs ops at the fintech" },
    { displayName: "priya  nair", reason: "skipped", context: "second capture" },
    { displayName: "Later Added", reason: "rejected" },
    { displayName: "   ", reason: "mentioned" },
  ]);
  check("a batch dedupes on the normalized name and drops blanks", n === 2, `${n}`);
  let list = await listIgnoredPeopleFor(USER);
  check("one row per name", list.length === 2, JSON.stringify(list.map((p) => p.displayName)));
  const priya = list.find((p) => normalizePersonKey(p.displayName) === "priya nair")!;
  check("the latest capture's reason and context win", priya.reason === "skipped" && priya.context === "second capture", JSON.stringify(priya));

  await upsertIgnoredPeople(USER, [{ displayName: "Priya Nair", reason: "mentioned", context: "third capture" }]);
  check("re-upserting updates in place", (await countIgnoredPeopleFor(USER)) === 2 && (await listIgnoredPeopleFor(USER)).find((p) => p.displayName === "Priya Nair")?.context === "third capture");

  await db.insert(contacts).values({ userId: USER, fullName: "Later Added" });
  list = await listIgnoredPeopleFor(USER);
  check("adding them anywhere drops them off the list", !list.some((p) => p.displayName === "Later Added"));
  check("and the row is gone, not just hidden", (await countIgnoredPeopleFor(USER)) === 1);
  check("the ones still missing stay", list.some((p) => p.displayName === "Priya Nair"));

  await db.insert(contacts).values({ userId: USER, fullName: "Priyanka Nair", preferredName: "Priya Nair" });
  check("a preferred-name match counts too", (await listIgnoredPeopleFor(USER)).length === 0);

  await upsertIgnoredPeople(USER, [{ displayName: "Charles Babbage", reason: "mentioned", context: "her collaborator", company: "Analytical Engines" }]);
  const row = (await listIgnoredPeopleFor(USER))[0]!;
  const promoted = await promoteIgnoredPerson(USER, row.id);
  check("Add as contact creates the contact", promoted?.created === true && Boolean(promoted.contactId));
  const created = await db.query.contacts.findFirst({ where: eq(contacts.id, promoted!.contactId) });
  check("with the company and the note's context", created?.company === "Analytical Engines" && created?.notes === "her collaborator", JSON.stringify(created));
  check("and removes the row", (await countIgnoredPeopleFor(USER)) === 0);
  check("promoting a missing row is null, not a throw", (await promoteIgnoredPerson(USER, row.id)) === null);

  await upsertIgnoredPeople(USER, [{ displayName: "Gone Soon", reason: "rejected" }]);
  const gone = (await listIgnoredPeopleFor(USER))[0]!;
  check("another user cannot remove it", !(await removeIgnoredPerson("nope", gone.id)));
  check("the owner can", await removeIgnoredPerson(USER, gone.id));

  await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-ignored-people: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
