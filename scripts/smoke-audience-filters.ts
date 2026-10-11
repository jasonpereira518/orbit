import "./smoke/_env";
/**
 * The Alumni and Target companies filters on the contacts list, and the shared school
 * normaliser they match with. Restores the user's schools, targets and contacts afterwards:
 * the pglite smokes share one DB.
 * Run: npx tsx scripts/smoke-audience-filters.ts
 */
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, targetCompanies } from "../src/db/schema";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { audienceFilterAvailability } from "../src/lib/audience-filters";
import { addTargetCompany, setSchools } from "../src/lib/events/target-companies";
import { ensureUserSettings } from "../src/lib/user-settings";
import { sharesSchool } from "../src/lib/school-name";

const USER = "smoke-audience-filters";
let failures = 0;
const check = (label: string, ok: boolean) => { if (ok) console.log(`  ok   ${label}`); else { failures++; console.error(`  FAIL ${label}`); } };
const names = (p: Awaited<ReturnType<typeof listContactsPage>>) => p.items.map((c) => c.fullName).sort();

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(targetCompanies).where(eq(targetCompanies.userId, USER));
  await db.delete(companies).where(eq(companies.userId, USER));
  await setSchools(USER, []);
}

async function main() {
  check("sharesSchool folds the long name and the short form",
    sharesSchool(["University of North Carolina"], ["UNC"]) === true);

  const db = await getDb();
  await ensureUserSettings(USER);
  await cleanup();
  await setSchools(USER, ["University of North Carolina"]);
  await addTargetCompany(USER, "Acme Robotics");
  await db.insert(contacts).values([
    { userId: USER, fullName: "A", school: "UNC", company: "Acme Robotics" },
    { userId: USER, fullName: "B", school: "UNC", company: "Other Co" },
    { userId: USER, fullName: "C", company: "Acme Robotics" },
    { userId: USER, fullName: "D", company: "Other Co" },
  ]);

  check("alumni", JSON.stringify(names(await listContactsPage(USER, { alumni: true }))) === JSON.stringify(["A", "B"]));
  check("targets", JSON.stringify(names(await listContactsPage(USER, { targets: true }))) === JSON.stringify(["A", "C"]));
  check("alumni AND targets", JSON.stringify(names(await listContactsPage(USER, { alumni: true, targets: true }))) === JSON.stringify(["A"]));
  check("availability with both", JSON.stringify(await audienceFilterAvailability(USER)) === JSON.stringify({ hasSchools: true, hasTargets: true }));

  await setSchools(USER, []);
  check("alumni with no schools returns nothing", (await listContactsPage(USER, { alumni: true })).items.length === 0);
  check("availability reports it", (await audienceFilterAvailability(USER)).hasSchools === false);
}

main()
  .catch((e) => { failures++; console.error(e); })
  .finally(async () => {
    await cleanup().catch(() => {});
    if (failures) { console.error(`\n${failures} audience filter check(s) failed`); process.exit(1); }
    console.log("\naudience filters ok");
    process.exit(0);
  });
