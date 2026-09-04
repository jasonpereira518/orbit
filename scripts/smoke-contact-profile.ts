/**
 * The LinkedIn profile store: tables exist, rows cascade with their contact.
 * Later tasks extend this file with precedence, the slug guard, and search.
 *
 * Writes to a throwaway PGlite dir. Run: npx tsx scripts/smoke-contact-profile.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-contact-profile";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-contact-profile";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { contactExperiences, contactProfiles, contacts } from "../src/db/schema";
import {
  getCareerLines,
  getContactProfile,
  saveContactProfile,
  type IncomingProfile,
} from "../src/lib/contact-profile";
import { hybridSearchContacts } from "../src/lib/hybrid-search";

const USER = "smoke-contact-profile-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

async function makeContact(fullName: string, linkedinUrl: string | null) {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({ userId: USER, fullName, linkedinUrl })
    .returning();
  return row.id;
}

async function main() {
  await reset();
  const db = await getDb();
  const contactId = await makeContact("Ada Lovelace", "https://www.linkedin.com/in/ada");

  await db.insert(contactProfiles).values({
    userId: USER,
    contactId,
    headline: "Analytical engine person",
    about: "Notes on the engine.",
    skills: [{ name: "Mathematics" }],
    certifications: [],
    volunteering: [],
    publications: [],
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/ada",
    adapterVersion: "linkedin-2",
    warnings: [],
    capturedAt: new Date(),
  });

  await db.insert(contactExperiences).values({
    userId: USER,
    contactId,
    kind: "role",
    organization: "Analytical Engine Co",
    organizationNormalized: "analytical engine co",
    title: "Programmer",
    startYear: 1842,
    isCurrent: true,
    sortIndex: 0,
    source: "extension",
  });

  const profiles = await db.query.contactProfiles.findMany({
    where: eq(contactProfiles.contactId, contactId),
  });
  check("profile row stored", profiles.length === 1);
  check("jsonb round-trips", profiles[0].skills?.[0]?.name === "Mathematics");

  await db.delete(contacts).where(eq(contacts.id, contactId));
  const afterProfiles = await db.query.contactProfiles.findMany({
    where: eq(contactProfiles.contactId, contactId),
  });
  const afterExperiences = await db.query.contactExperiences.findMany({
    where: eq(contactExperiences.contactId, contactId),
  });
  check("profile cascades with contact", afterProfiles.length === 0);
  check("experiences cascade with contact", afterExperiences.length === 0);

  // --- precedence ---------------------------------------------------------------
  const bobId = await makeContact("Bob Ross", "https://www.linkedin.com/in/bobross");

  const apolloProfile: IncomingProfile = {
    source: "apollo",
    sourceUrl: null,
    adapterVersion: null,
    capturedAt: new Date("2026-09-01T00:00:00Z"),
    warnings: [],
    headline: null,
    about: null,
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "Apollo Guess Co", title: "Painter", startYear: 2010,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  };

  const first = await saveContactProfile(USER, bobId, apolloProfile);
  check("apollo writes when nothing is stored", first.written && first.reason === "saved");

  const secondApollo = await saveContactProfile(USER, bobId, {
    ...apolloProfile,
    capturedAt: new Date("2026-09-02T00:00:00Z"),
    experiences: [
      { kind: "role", organization: "Apollo Newer Co", title: "Painter", startYear: 2011,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  });
  check("apollo replaces its own older profile", secondApollo.written);
  const afterApollo = await getContactProfile(USER, bobId);
  check(
    "apollo replacement is not a union with the old rows",
    afterApollo?.experiences.length === 1 &&
      afterApollo.experiences[0].organization === "Apollo Newer Co"
  );

  const extensionSave = await saveContactProfile(USER, bobId, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/bobross",
    adapterVersion: "linkedin-2",
    capturedAt: new Date("2026-09-03T00:00:00Z"),
    warnings: [],
    headline: "Happy little trees",
    about: "There are no mistakes.",
    skills: [{ name: "Oil painting" }],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "PBS", title: "Host", startYear: 1983, startMonth: 1,
        endYear: 1994, endMonth: 5, isCurrent: false, location: null, description: null,
        fieldOfStudy: null },
      { kind: "role", organization: "Ramp", title: "Advisor", startYear: 2020,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
      { kind: "education", organization: "Art School", title: "BFA", startYear: null,
        startMonth: null, endYear: null, endMonth: null, isCurrent: false, location: null,
        description: null, fieldOfStudy: "Painting" },
    ],
  });
  check("extension overwrites an apollo profile", extensionSave.written);

  const stored = await getContactProfile(USER, bobId);
  check("extension capture replaces prose", stored?.about === "There are no mistakes.");
  check("stored source is the extension", stored?.source === "extension");
  check(
    "the delete crosses sources — no apollo rows survive",
    stored?.experiences.every((e) => e.source === "extension") === true,
    stored?.experiences.map((e) => `${e.organization}:${e.source}`).join(", ")
  );
  check("all three entries stored", stored?.experiences.length === 3);
  check(
    "organization is normalized for search",
    stored?.experiences.some((e) => e.organizationNormalized === "pbs") === true
  );
  check(
    "stored experiences come back in display order",
    stored?.experiences[0].organization === "Ramp",
    stored?.experiences.map((e) => e.organization).join(" > ")
  );

  // --- embedding invalidation ---------------------------------------------------
  // Clear the flag directly first, so the refused save's effect on it is provable rather
  // than riding on the stamp left behind by an earlier successful save.
  await db
    .update(contacts)
    .set({ embeddingStaleAt: null })
    .where(and(eq(contacts.userId, USER), eq(contacts.id, bobId)));

  const blocked = await saveContactProfile(USER, bobId, {
    ...apolloProfile,
    capturedAt: new Date("2026-09-04T00:00:00Z"),
  });
  check(
    "apollo never overwrites an extension capture, even a newer one",
    !blocked.written && blocked.reason === "outranked"
  );
  const afterBlocked = await getContactProfile(USER, bobId);
  check("the extension profile survived", afterBlocked?.about === "There are no mistakes.");

  const [afterBlockedRow] = await db
    .select({ staleAt: contacts.embeddingStaleAt })
    .from(contacts)
    .where(eq(contacts.id, bobId));
  check(
    "a refused write leaves the embedding flag untouched",
    afterBlockedRow.staleAt === null
  );

  const acceptedAgain = await saveContactProfile(USER, bobId, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/bobross",
    adapterVersion: "linkedin-2",
    capturedAt: new Date("2026-09-05T00:00:00Z"),
    warnings: [],
    headline: "Happy little trees",
    about: "There are no mistakes.",
    skills: [{ name: "Oil painting" }],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "PBS", title: "Host", startYear: 1983, startMonth: 1,
        endYear: 1994, endMonth: 5, isCurrent: false, location: null, description: null,
        fieldOfStudy: null },
      { kind: "role", organization: "Ramp", title: "Advisor", startYear: 2020,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
      { kind: "education", organization: "Art School", title: "BFA", startYear: null,
        startMonth: null, endYear: null, endMonth: null, isCurrent: false, location: null,
        description: null, fieldOfStudy: "Painting" },
    ],
  });
  check("accepted save reports written", acceptedAgain.written);
  const [bobRow] = await db
    .select({ staleAt: contacts.embeddingStaleAt })
    .from(contacts)
    .where(eq(contacts.id, bobId));
  check("saving a profile flags the contact for re-embedding", bobRow.staleAt !== null);

  // --- career lines -------------------------------------------------------------
  const lines = await getCareerLines(USER, [bobId]);
  check(
    "career line reads for chat",
    lines.get(bobId) === "Ramp, ex-PBS · Art School",
    lines.get(bobId) ?? "null"
  );

  // --- past employers are findable ----------------------------------------------
  //
  // The whole point of the feature: someone who left Google in 2019 has no Google
  // anywhere on their contact row, so only the experiences table can find them.
  const exGoogleId = await makeContact("Grace Hopper", "https://www.linkedin.com/in/grace");
  await saveContactProfile(USER, exGoogleId, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/grace",
    adapterVersion: "linkedin-2",
    capturedAt: new Date(),
    warnings: [],
    headline: null,
    about: null,
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "Ramp", title: "Staff Engineer", startYear: 2019,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
      { kind: "role", organization: "Google LLC", title: "Engineer", startYear: 2015,
        startMonth: null, endYear: 2019, endMonth: null, isCurrent: false, location: null,
        description: null, fieldOfStudy: null },
      { kind: "education", organization: "Yale", title: "PhD", startYear: null,
        startMonth: null, endYear: null, endMonth: null, isCurrent: false, location: null,
        description: null, fieldOfStudy: "Mathematics" },
    ],
  });

  const [graceRow] = await db
    .select({ company: contacts.company })
    .from(contacts)
    .where(eq(contacts.id, exGoogleId));
  check("the contact row itself says nothing about Google", graceRow.company === null);

  // The load-bearing assertion. No filters at all — nothing about this query matches
  // Grace's name, company, or search_tsv, so ONLY an experience arm can surface her.
  // If this passes with the arm removed, the test is not testing anything.
  const bareHits = await hybridSearchContacts(USER, { query: "google", limit: 10 });
  check(
    "a bare query surfaces a past employer — the arm produces candidates",
    bareHits.some((h) => h.id === exGoogleId),
    bareHits.map((h) => h.fullName).join(", ") || "no hits"
  );

  const schoolHits = await hybridSearchContacts(USER, { query: "yale", limit: 10 });
  check(
    "a past school is surfaced too",
    schoolHits.some((h) => h.id === exGoogleId),
    schoolHits.map((h) => h.fullName).join(", ") || "no hits"
  );

  // And the filter narrows correctly once a candidate exists.
  const filtered = await hybridSearchContacts(USER, {
    query: "google",
    filters: { companies: ["Google"] },
    limit: 10,
  });
  // `.some(...)` is NOT enough here and the distinction is the entire point of Step 4:
  // when the filter discards Grace, the recall guard re-runs the search unfiltered and
  // hands her back anyway as a BACKFILL row. She is present either way. Only
  // `filterMatched` separates "the filter kept her" from "the filter dropped her and the
  // recall guard papered over it" — with `.some`, deleting `experienceExists` from the
  // companies block leaves this assertion still passing.
  const filteredGrace = filtered.find((h) => h.id === exGoogleId);
  check(
    "the companies filter keeps a past-employer match as a real filtered hit",
    filteredGrace?.filterMatched === true,
    filteredGrace
      ? `found but filterMatched=${filteredGrace.filterMatched} (recall-guard backfill)`
      : "not found at all"
  );

  // A term that matches nobody's history must not drag everyone in.
  const noise = await hybridSearchContacts(USER, { query: "zzzznotacompany", limit: 10 });
  check("an unmatched term surfaces nobody through the arm", noise.every((h) => h.id !== exGoogleId));

  // --- the arm must be selective, not just precise --------------------------------
  //
  // A bare legal suffix is a word every "... Inc" in the table shares. The word-boundary
  // tier matches it exactly and correctly, which is the problem: precision is not
  // selectivity. LEGAL_SUFFIXES drops such a term before it ever reaches SQL.
  const suffixOnlyId = await makeContact("Wendy Widgets", null);
  await saveContactProfile(USER, suffixOnlyId, {
    source: "extension", sourceUrl: null, adapterVersion: "linkedin-2",
    capturedAt: new Date(), warnings: [], headline: null, about: null,
    skills: [], certifications: [], volunteering: [], publications: [],
    experiences: [
      { kind: "role", organization: "Widgets Inc", title: "Founder", startYear: 2010,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  });
  const suffixHits = await hybridSearchContacts(USER, { query: "inc", limit: 10 });
  check(
    "a bare legal suffix surfaces nobody through the arm",
    suffixHits.every((h) => h.id !== suffixOnlyId),
    suffixHits.map((h) => h.fullName).join(", ") || "no hits"
  );
  // ...but the company name itself is still reachable, so the stoplist is per-term.
  const widgetHits = await hybridSearchContacts(USER, { query: "widgets inc", limit: 10 });
  check(
    "the same query minus the suffix still reaches the employer",
    widgetHits.some((h) => h.id === suffixOnlyId),
    widgetHits.map((h) => h.fullName).join(", ") || "no hits"
  );

  // --- the recency tiebreak is real logic, so pin the order it produces ------------
  //
  // Both contacts match "zynthia" at the same tier, so match_score ties and ONLY the
  // is_current / end_year tiebreak can separate them. Neither name contains the term,
  // so neither can arrive through fts or trigram — this is the experience arm alone.
  const stillThereId = await makeContact("Pat Ongoing", null);
  const departedId = await makeContact("Sam Departed", null);
  const zynthia = (isCurrent: boolean, endYear: number | null) => ({
    source: "extension" as const, sourceUrl: null, adapterVersion: "linkedin-2",
    capturedAt: new Date(), warnings: [], headline: null, about: null,
    skills: [], certifications: [], volunteering: [], publications: [],
    experiences: [
      { kind: "role" as const, organization: "Zynthia Labs", title: "Engineer",
        startYear: 2012, startMonth: null, endYear, endMonth: null, isCurrent,
        location: null, description: null, fieldOfStudy: null },
    ],
  });
  // Seed the departed contact FIRST, so passing by insertion order alone is not possible.
  await saveContactProfile(USER, departedId, zynthia(false, 2015));
  await saveContactProfile(USER, stillThereId, zynthia(true, null));

  const tieHits = await hybridSearchContacts(USER, { query: "zynthia", limit: 10 });
  const currentRank = tieHits.findIndex((h) => h.id === stillThereId);
  const pastRank = tieHits.findIndex((h) => h.id === departedId);
  check(
    "both same-employer contacts come back through the arm",
    currentRank >= 0 && pastRank >= 0,
    tieHits.map((h) => `${h.fullName}[${h.matchedArms.join("+")}]`).join(", ") || "no hits"
  );
  check(
    "a current role outranks an ended one at the same match score",
    currentRank < pastRank,
    tieHits.map((h) => h.fullName).join(" > ")
  );

  console.log("\ncontact profile storage: OK");
}

run(main);
