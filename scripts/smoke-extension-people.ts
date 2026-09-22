/**
 * Pages about more than one person — pick lists and organizations — and GitHub.
 *
 *   - Batch resolve: an exact identity (LinkedIn URL, email, GitHub) is "known";
 *     a NAME alone is only ever "possible". Two people share a name all the time.
 *   - Company lookup: current by the contact record ("Stripe, Inc." and "stripe"
 *     are one company), former by work history; a boomerang who is there again
 *     counts once, as current; the names are Pro, the counts are free.
 *   - GitHub: a GitHub profile resolves to the contact whose website is it, and a
 *     GitHub bio's link to someone's LinkedIn resolves them too.
 *   - Tenancy throughout.
 *
 * Run: npx tsx scripts/smoke-extension-people.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contactExperiences, contactIdentities, contacts } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { normalizeCompanyKey } from "../src/lib/company-name";
import { identityKeysFor } from "../src/lib/duplicates";
import type { PageContext } from "../src/lib/extension/contract";
import { companyKey, companyKeySql, lookupCompany, resolveBatch } from "../src/lib/extension/people";
import { matchesForPage } from "../src/lib/extension/resolve";

const USER = "smoke-ext-people-user";
const OTHER = "smoke-ext-people-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(contactExperiences).where(eq(contactExperiences.userId, user));
    await db.delete(contactIdentities).where(eq(contactIdentities.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
}

async function seed(userId: string, values: Partial<typeof contacts.$inferInsert> & { fullName: string }) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, ...values }).returning();
  await claimIdentities(userId, row.id, identityKeysFor(values), "smoke");
  return row;
}

async function pastRole(userId: string, contactId: string, organization: string, isCurrent = false) {
  const db = await getDb();
  await db.insert(contactExperiences).values({
    userId,
    contactId,
    kind: "role",
    organization,
    organizationNormalized: normalizeCompanyKey(organization),
    isCurrent,
    source: "apollo",
  });
}

const field = (value: string) => ({ value, source: "smoke", confidence: "high" as const });
function page(site: PageContext["site"], url: string, identity: Partial<PageContext["identity"]> = {}): PageContext {
  return {
    schemaVersion: 1,
    site,
    adapterVersion: "smoke-1",
    kind: "person",
    url,
    sourceUrl: url,
    capturedAt: new Date().toISOString(),
    identity: {
      name: null, headline: null, title: null, company: null, location: null,
      school: null, email: null, handle: null, profileUrl: null, photoUrl: null,
      ...identity,
    },
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    warnings: [],
  };
}

run(async () => {
  await cleanup();

  const amara = await seed(USER, {
    fullName: "Amara Osei",
    company: "Stripe, Inc.",
    linkedinUrl: "https://www.linkedin.com/in/amara-osei",
  });
  const ben = await seed(USER, { fullName: "Ben Tate", company: "stripe" });
  const chioma = await seed(USER, { fullName: "Chioma Eze", company: "Anthropic", email: "chioma@anthropic.com" });
  const dev = await seed(USER, { fullName: "Dev Rao", website: "github.com/DevRao/" });
  await seed(OTHER, { fullName: "Amara Osei", company: "Stripe", linkedinUrl: "https://www.linkedin.com/in/amara-osei" });

  await pastRole(USER, chioma.id, "Stripe"); // left Stripe for Anthropic
  await pastRole(USER, dev.id, "Stripe Inc"); // left Stripe, current employer unknown
  await pastRole(USER, ben.id, "Stripe"); // a boomerang: there before, there again now

  console.log("batch resolve");
  const items = await resolveBatch(USER, [
    { name: "Amara Osei", profileUrl: "https://de.linkedin.com/in/amara-osei/" },
    { name: "Ben Tate" },
    { name: "C. Eze", email: "Chioma@Anthropic.com" },
    { name: "Dev", profileUrl: "https://github.com/devrao" },
    { name: "Someone New", profileUrl: "https://www.linkedin.com/in/someone-new" },
  ]);
  check("an exact LinkedIn URL is known", items[0].status === "known" && items[0].contact?.id === amara.id, JSON.stringify(items[0]));
  check("a name alone is only possible, never known", items[1].status === "possible" && items[1].contact?.id === ben.id, JSON.stringify(items[1]));
  check("an email is an identity, whatever name the row shows", items[2].status === "known" && items[2].contact?.id === chioma.id, JSON.stringify(items[2]));
  check("a GitHub profile is known through the stored website", items[3].status === "known" && items[3].contact?.id === dev.id, JSON.stringify(items[3]));
  check("a stranger is new", items[4].status === "new" && items[4].contact === null);
  check("indexes line up with the request", items.every((item, i) => item.index === i));
  check(
    "another user's contact on the same profile is never returned",
    items.every((item) => item.contact?.id !== undefined ? [amara.id, ben.id, chioma.id, dev.id].includes(item.contact.id) : true)
  );

  console.log("company lookup");
  for (const [name, want] of [
    ["Stripe, Inc.", "stripe"],
    ["stripe", "stripe"],
    ["Stripe Inc", "stripe"],
    ["Acme Co. Ltd", "acme"],
    ["Co", "co"],
  ] as const) {
    check(`"${name}" keys to "${want}"`, companyKey(name) === want, companyKey(name));
  }
  // The SQL spelling of the same key, over stored values, must agree with JS.
  const db = await getDb();
  for (const stored of ["Stripe, Inc.", "  STRIPE  ", "Stripe Inc", "Acme Co. Ltd", "Co"]) {
    // The real expression lookupCompany uses, not a copy of it.
    const [row] = await db
      .execute(sql`select ${companyKeySql(sql`${stored}::text`)} as key`)
      .then((r) => rowsOf<{ key: string }>(r));
    check(`SQL agrees with JS on "${stored}"`, row?.key === companyKey(stored), `${row?.key} vs ${companyKey(stored)}`);
  }
  const free = await lookupCompany(USER, { name: "Stripe" }, { includePeople: false });
  check("free: counts current employees", free.currentTotal === 2, String(free.currentTotal));
  check("free: counts former ones by work history", free.formerTotal === 2, String(free.formerTotal));
  check("free: no names — those are Pro", free.people.length === 0 && free.locked === true);

  const pro = await lookupCompany(USER, { name: "Stripe" }, { includePeople: true });
  const rel = (id: string) => pro.people.find((p) => p.id === id)?.relation;
  check("Pro: current employees are named as current", rel(amara.id) === "current" && rel(ben.id) === "current");
  check("Pro: people who left are named as former", rel(chioma.id) === "former" && rel(dev.id) === "former");
  check(
    "a boomerang counts once, as current",
    pro.people.filter((p) => p.id === ben.id).length === 1 && rel(ben.id) === "current"
  );
  check("another user's Stripe contact is never counted", pro.currentTotal === 2 && pro.people.length === 4, JSON.stringify(pro.people.map((p) => p.fullName)));
  const nobody = await lookupCompany(USER, { name: "Initech" }, { includePeople: true });
  check("an organization nobody works at is zero, not an error", nobody.currentTotal === 0 && nobody.formerTotal === 0);

  console.log("GitHub");
  let r = await matchesForPage(USER, page("github", "https://github.com/devrao", { handle: field("devrao"), name: field("Dev Rao") }));
  check(
    "a GitHub profile resolves to the contact whose website it is",
    r.status === "confident" && r.matches[0]?.contact.id === dev.id,
    `${r.status} ${JSON.stringify(r.matches.map((m) => m.reason))}`
  );
  check("…for the stated reason", r.matches[0]?.reason === "Same GitHub profile");

  r = await matchesForPage(
    USER,
    page("github", "https://github.com/amaraosei", {
      handle: field("amaraosei"),
      links: { linkedin: "https://www.linkedin.com/in/amara-osei" },
    })
  );
  check(
    "a GitHub bio's LinkedIn link resolves the person",
    r.status === "confident" && r.matches[0]?.contact.id === amara.id,
    `${r.status} ${JSON.stringify(r.matches.map((m) => m.reason))}`
  );

  await cleanup();
  if (failures) {
    console.error(`\nsmoke-extension-people: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-people: all checks passed");
});
