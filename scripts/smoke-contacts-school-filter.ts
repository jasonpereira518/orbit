/**
 * The Contacts School filter: `?school=<name>` and `?school=@mine` ("Same school as me").
 *
 * Alumni match on the contact's own `school` OR an education entry from their stored LinkedIn
 * history — the same `schoolCondition` chat's `schools` filter uses — and "@mine" reads the
 * user's own schools from `user_settings.schools`. A user with no schools gets nobody, not
 * everybody.
 *
 * Run: npx tsx scripts/smoke-contacts-school-filter.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactExperiences, contacts, userSettings } from "../src/db/schema";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { SAME_SCHOOL_AS_ME } from "../src/lib/contacts-page";
import { setSchools } from "../src/lib/events/target-companies";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-school-filter";
const OTHER = "smoke-school-filter-other";

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
  for (const id of [USER, OTHER]) {
    await db.delete(contactExperiences).where(eq(contactExperiences.userId, id));
    await db.delete(contacts).where(eq(contacts.userId, id));
    await db.delete(userSettings).where(eq(userSettings.userId, id));
  }
}

async function addContact(userId: string, fullName: string, school: string | null) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, school }).returning();
  return row.id;
}

async function names(filters: Parameters<typeof listContactsPage>[1]) {
  const page = await listContactsPage(USER, { ...filters, limit: 200 });
  return page.items.map((c) => c.fullName).sort().join(",");
}

async function main() {
  await reset();
  const db = await getDb();
  await ensureUserSettings(USER);

  await addContact(USER, "Ana Alum", "University of North Carolina at Chapel Hill");
  const history = await addContact(USER, "Ben History", null);
  await db.insert(contactExperiences).values({
    userId: USER,
    contactId: history,
    kind: "education",
    organization: "UNC Chapel Hill",
    organizationNormalized: "unc chapel hill",
    source: "web",
  });
  await addContact(USER, "Cal Stanford", "Stanford University");
  await addContact(USER, "Dee Nobody", null);
  await addContact(OTHER, "Eve Elsewhere", "University of North Carolina at Chapel Hill");

  console.log("\nOne school");
  check("matches the contact's own school, case-insensitively", (await names({ school: "north carolina" })) === "Ana Alum");
  check("…and an education entry from their LinkedIn history", (await names({ school: "chapel hill" })) === "Ana Alum,Ben History");
  check("never reaches another user's contacts", !(await names({ school: "chapel hill" })).includes("Eve"));

  console.log("\nSame school as me");
  check("with no schools of your own, nobody matches", (await names({ school: SAME_SCHOOL_AS_ME })) === "");
  await setSchools(USER, ["Chapel Hill", "Stanford"]);
  check(
    "any of your schools, either source",
    (await names({ school: SAME_SCHOOL_AS_ME })) === "Ana Alum,Ben History,Cal Stanford",
    await names({ school: SAME_SCHOOL_AS_ME })
  );
  check("no filter is everyone", (await names({})) === "Ana Alum,Ben History,Cal Stanford,Dee Nobody");

  await reset();
  console.log(failures === 0 ? "\nall school-filter checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
