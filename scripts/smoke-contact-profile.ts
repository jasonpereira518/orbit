/**
 * The LinkedIn profile store: tables exist, rows cascade with their contact.
 * Later tasks extend this file with precedence, the slug guard, and search.
 *
 * Writes to a throwaway PGlite dir. Run: npx tsx scripts/smoke-contact-profile.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-contact-profile";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-contact-profile";

import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { run } from "./smoke/_env";
import { getDb, runAtomicWrite, schema } from "../src/db";
import { contactExperiences, contactProfiles, contacts } from "../src/db/schema";
import {
  getCareerLines,
  getContactProfile,
  saveContactProfile,
  type IncomingProfile,
} from "../src/lib/contact-profile";
import { hybridSearchContacts } from "../src/lib/hybrid-search";
import { buildContactEmbeddingContent } from "../src/lib/search";
import { apolloEmploymentToExperiences } from "../src/lib/apollo";
import { captureContactProfile } from "../src/lib/extension/profile-capture";
import { pageContextSchema, pageExperienceSchema } from "../src/lib/extension/contract.schema";
import type { PageContext } from "../src/lib/extension/contract";
import { ContactNotFoundError } from "../src/lib/contact-writes";
import { ExtensionRouteError } from "../src/lib/extension/http";

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

  // --- punctuated employers are reachable by the name people actually type ---------
  //
  // `organization_normalized` is written through `normalizeCompanyKey`, which strips
  // punctuation to single spaces: "AT&T" is stored as `at t`. Query terms were only
  // lowercased, so the literal string `at t` was the ONLY way to reach this row — "AT&T"
  // itself, the form every user types, matched nothing. The fix runs query terms through
  // the same function, which is why it was hoisted into `@/lib/company-name` at all.
  const punctuatedId = await makeContact("Perry Punctuation", null);
  await saveContactProfile(USER, punctuatedId, {
    source: "extension", sourceUrl: null, adapterVersion: "linkedin-2",
    capturedAt: new Date(), warnings: [], headline: null, about: null,
    skills: [], certifications: [], volunteering: [], publications: [],
    experiences: [
      { kind: "role", organization: "AT&T", title: "Engineer", startYear: 2011,
        startMonth: null, endYear: 2016, endMonth: null, isCurrent: false, location: null,
        description: null, fieldOfStudy: null },
      { kind: "role", organization: "L'Oréal", title: "Analyst", startYear: 2017,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  });
  for (const typed of ["AT&T", "at&t"]) {
    const hits = await hybridSearchContacts(USER, { query: typed, limit: 10 });
    check(
      `a punctuated past employer is reachable as "${typed}"`,
      hits.some((h) => h.id === punctuatedId),
      hits.map((h) => h.fullName).join(", ") || "no hits"
    );
  }
  const accentHits = await hybridSearchContacts(USER, { query: "L'Oréal", limit: 10 });
  check(
    "an accented, apostrophised employer is reachable as written",
    accentHits.some((h) => h.id === punctuatedId),
    accentHits.map((h) => h.fullName).join(", ") || "no hits"
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

  // --- embedding content --------------------------------------------------------
  const graceProfile = await getContactProfile(USER, exGoogleId);
  const content = buildContactEmbeddingContent({
    fullName: "Grace Hopper",
    profile: graceProfile,
    experiences: graceProfile?.experiences ?? [],
  });
  check("embedding content names the past employer", content.includes("Google LLC"), content);
  check("embedding content names the school", content.includes("Yale"), content);
  check(
    "embedding content is unchanged for a contact with no profile",
    buildContactEmbeddingContent({ fullName: "Nobody" }) === "Nobody"
  );

  // --- a long About must not truncate the career line out of the vector -----------
  //
  // `createEmbedding`/`createEmbeddingsBatch` blindly slice the built content to 8,000
  // chars. `about` is capped at 8,000 chars on the way into storage (see
  // `contact-profile.ts`'s `trimmed(incoming.about, 8000)`), so a near-limit About plus a
  // headline and title can push the total past 8,000 before the career line is even
  // appended. If the career line and headline were ordered AFTER `about` (as they were
  // before this fix), a past employer sitting past the cutoff would be silently dropped
  // from every semantic search — this asserts the field ordering, not the string length.
  const longAbout = "A".repeat(7995);
  const nearLimitContent = buildContactEmbeddingContent({
    fullName: "Near Limit Person",
    title: "Some Title",
    profile: { headline: "Near Limit Headline", about: longAbout },
    experiences: [
      {
        kind: "role",
        organization: "Definitely A Past Employer Inc",
        title: null,
        fieldOfStudy: null,
        startYear: 2010,
        startMonth: null,
        endYear: 2015,
        endMonth: null,
        isCurrent: false,
        sortIndex: 0,
      },
    ],
  });
  const truncatedForEmbedding = nearLimitContent.slice(0, 8000);
  check(
    "a near-limit About does not truncate the past employer out of the embedded content",
    truncatedForEmbedding.includes("Definitely A Past Employer Inc"),
    `content length ${nearLimitContent.length}`
  );
  check(
    "a near-limit About does not truncate the headline out of the embedded content",
    truncatedForEmbedding.includes("Near Limit Headline"),
    `content length ${nearLimitContent.length}`
  );

  // --- apollo employment history -------------------------------------------------
  const converted = apolloEmploymentToExperiences({
    employment_history: [
      { organization_name: "Ramp", title: "Engineer", start_date: "2023-04-01",
        end_date: null, current: true },
      { organization_name: "Stripe", title: "Engineer", start_date: "2019-01-01",
        end_date: "2023-03-01", current: false },
      { organization_name: "MIT", degree: "BS", major: "EECS", kind: "education",
        start_date: "2015-09-01", end_date: "2019-06-01", current: false },
      { organization_name: "Stanford", degree: "PhD", major: "CS", kind: "education",
        start_date: "2023-09-01", end_date: null, current: true },
      { organization_name: "  ", title: "Ghost", current: false },
    ],
  });

  check("employment rows become roles", converted.filter((e) => e.kind === "role").length === 2);
  check(
    "degree rows become education, not roles",
    converted.find((e) => e.organization === "MIT")?.kind === "education"
  );
  check(
    "education carries its field of study",
    converted.find((e) => e.organization === "MIT")?.fieldOfStudy === "EECS"
  );
  check(
    "dates are split into parts",
    converted.find((e) => e.organization === "Stripe")?.startYear === 2019 &&
      converted.find((e) => e.organization === "Stripe")?.startMonth === 1 &&
      converted.find((e) => e.organization === "Stripe")?.endYear === 2023
  );
  check("the current flag survives", converted.find((e) => e.organization === "Ramp")?.isCurrent === true);
  check(
    "an in-progress degree is never a current role",
    converted.find((e) => e.organization === "Stanford")?.kind === "education" &&
      converted.find((e) => e.organization === "Stanford")?.isCurrent === false
  );
  check("nameless rows are dropped", converted.every((e) => e.organization.trim().length > 0));

  // --- extension capture ---------------------------------------------------------
  const v1Page = {
    schemaVersion: 1,
    site: "linkedin",
    adapterVersion: "linkedin-1",
    kind: "person",
    url: "https://www.linkedin.com/in/ada",
    sourceUrl: "https://www.linkedin.com/in/ada",
    capturedAt: new Date().toISOString(),
    identity: {
      name: { value: "Ada", source: "h1", confidence: "high" },
      headline: null, title: null, company: null, location: null, school: null,
      email: null, handle: null, profileUrl: null, photoUrl: null,
    },
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    warnings: [],
  };
  check(
    "a v1 payload from an un-updated extension still validates",
    pageContextSchema.safeParse(v1Page).success
  );
  check(
    "a v2 payload validates",
    pageContextSchema.safeParse({ ...v1Page, schemaVersion: 2, adapterVersion: "linkedin-2" })
      .success
  );

  const capturePage = {
    ...v1Page,
    schemaVersion: 2 as const,
    adapterVersion: "linkedin-2",
    url: "https://www.linkedin.com/in/grace",
    sourceUrl: "https://www.linkedin.com/in/grace",
    profile: {
      headline: "Rear Admiral",
      about: "It is easier to ask forgiveness.",
      skills: [{ name: "COBOL" }],
      certifications: [],
      volunteering: [],
      publications: [],
      parseIncomplete: false,
      experiences: [
        { kind: "role", organization: "US Navy", title: "Rear Admiral", startYear: 1944,
          startMonth: null, endYear: 1986, endMonth: null, isCurrent: false,
          location: null, description: null, fieldOfStudy: null },
      ],
    },
  };

  // Cast because the literal above widens `site`/`kind` to `string`; the zod schema is
  // what actually validates this shape at runtime, and it was checked two lines up.
  const page = capturePage as unknown as PageContext;

  const captured = await captureContactProfile(USER, {
    contactId: exGoogleId,
    page,
  });
  check("a matching slug saves", captured.saved && captured.conflict === null);
  const graceAfter = await getContactProfile(USER, exGoogleId);
  check("the capture replaced the earlier profile", graceAfter?.about === "It is easier to ask forgiveness.");

  // The failure that matters: writing one person's career onto another.
  const mismatch = await captureContactProfile(USER, {
    contactId: bobId,
    page,
  });
  check("a slug mismatch refuses to write", !mismatch.saved);
  check(
    "and says who the page was actually about",
    mismatch.conflict?.pageSlug === "grace" && mismatch.conflict?.contactSlug === "bobross",
    JSON.stringify(mismatch.conflict)
  );
  const bobUntouched = await getContactProfile(USER, bobId);
  check("the wrong contact was not written", bobUntouched?.about === "There are no mistakes.");
  // A partial-write regression (profile row refused but experience rows still inserted,
  // or vice versa) would pass the check above alone — this would not.
  check(
    "no experience rows leaked onto the wrong contact either",
    bobUntouched?.experiences.every((e) => e.organization !== "US Navy") === true,
    bobUntouched?.experiences.map((e) => e.organization).join(", ")
  );
  const [bobRowAfterMismatch] = await db
    .select({ linkedinUrl: contacts.linkedinUrl })
    .from(contacts)
    .where(eq(contacts.id, bobId));
  check(
    "the wrong contact's stored URL was not touched by the refused write",
    bobRowAfterMismatch.linkedinUrl === "https://www.linkedin.com/in/bobross"
  );

  // --- the guard must fail CLOSED, not open, when the page's identity is unknown ---------
  //
  // A page URL with no identifiable LinkedIn slug at all (not even a malformed linkedin.com
  // one) is not "no opinion, proceed" — it must be refused exactly like a real mismatch
  // whenever the contact already has a known identity.
  const knownSlugId = await makeContact("Known Slug Person", "https://www.linkedin.com/in/knownslug");
  const noSlugPage = {
    ...capturePage,
    url: "https://example.com/nothing",
    sourceUrl: "https://example.com/nothing",
  } as unknown as PageContext;
  const refusedNoSlug = await captureContactProfile(USER, {
    contactId: knownSlugId,
    page: noSlugPage,
  });
  check(
    "a page with no identifiable LinkedIn slug is refused against a contact that has one",
    !refusedNoSlug.saved
  );
  const knownSlugProfileAfter = await getContactProfile(USER, knownSlugId);
  check("no profile was written for the unknown-identity refusal", knownSlugProfileAfter === null);
  const [knownSlugRow] = await db
    .select({ linkedinUrl: contacts.linkedinUrl })
    .from(contacts)
    .where(eq(contacts.id, knownSlugId));
  check(
    "its stored URL was not touched",
    knownSlugRow.linkedinUrl === "https://www.linkedin.com/in/knownslug"
  );

  // --- the guard is case-insensitive: uppercase /IN/ is the SAME slug, not "unknown" -----
  const upperCaseId = await makeContact("Upper Case Person", "https://www.linkedin.com/in/grace");
  const upperCasePage = {
    ...capturePage,
    url: "https://www.linkedin.com/IN/grace",
    sourceUrl: "https://www.linkedin.com/IN/grace",
  } as unknown as PageContext;
  const upperCaseCapture = await captureContactProfile(USER, {
    contactId: upperCaseId,
    page: upperCasePage,
  });
  check(
    "an uppercase /IN/ path is recognized as the same slug, not refused as unknown",
    upperCaseCapture.saved
  );

  // --- a malformed stored URL must not silently accept a mismatched capture, nor have its
  // own URL replaced -----------------------------------------------------------------------
  //
  // A Sales Navigator URL has no `/in/` segment, so it normalizes to the full URL text
  // rather than to null — it is a KNOWN (if unusual) identity, not a gap, and must guard the
  // contact exactly like a normal slug would.
  const salesNavUrl = "https://www.linkedin.com/sales/lead/ACwAAA,NAME_SEARCH";
  const salesNavId = await makeContact("Sales Nav Person", salesNavUrl);
  const salesNavCapture = await captureContactProfile(USER, { contactId: salesNavId, page });
  check("a contact with an unparseable stored URL is not silently written to", !salesNavCapture.saved);
  const salesNavProfileAfter = await getContactProfile(USER, salesNavId);
  check("no profile was written over the sales-nav contact", salesNavProfileAfter === null);
  const [salesNavRow] = await db
    .select({ linkedinUrl: contacts.linkedinUrl })
    .from(contacts)
    .where(eq(contacts.id, salesNavId));
  check("its sales-nav URL survived untouched", salesNavRow.linkedinUrl === salesNavUrl);

  // --- a contact belonging to another user must be indistinguishable from one that does not
  // exist at all -----------------------------------------------------------------------------
  const otherUserId = "smoke-contact-profile-other-user";
  const [otherUserContact] = await db
    .insert(contacts)
    .values({ userId: otherUserId, fullName: "Not Yours", linkedinUrl: null })
    .returning();

  async function captureThrows(contactId: string): Promise<string> {
    try {
      await captureContactProfile(USER, { contactId, page });
      return "did not throw";
    } catch (err) {
      return err instanceof ContactNotFoundError ? "ContactNotFoundError" : `wrong error: ${String(err)}`;
    }
  }
  const foreignResult = await captureThrows(otherUserContact.id);
  const missingResult = await captureThrows("00000000-0000-0000-0000-000000000000");
  check("a foreign contact throws ContactNotFoundError", foreignResult === "ContactNotFoundError", foreignResult);
  check(
    "a nonexistent contact throws the identical error",
    missingResult === "ContactNotFoundError",
    missingResult
  );
  await db.delete(contacts).where(eq(contacts.id, otherUserContact.id));

  // --- only a LinkedIn person page can carry a capture --------------------------------
  const nonProfilePageId = await makeContact("Not A Profile Target", null);
  const nonLinkedInPage = { ...capturePage, site: "gmail", kind: "thread" } as unknown as PageContext;
  let nonProfileRefused = false;
  try {
    await captureContactProfile(USER, { contactId: nonProfilePageId, page: nonLinkedInPage });
  } catch (err) {
    nonProfileRefused = err instanceof ExtensionRouteError && err.code === "invalid_request";
  }
  check(
    "a non-LinkedIn-person page is refused before it can be stored",
    nonProfileRefused
  );
  check(
    "nothing was written for the refused non-profile page",
    (await getContactProfile(USER, nonProfilePageId)) === null
  );

  // --- a capturedAt the extension mangled must not turn a capture into a 500 -------------
  const badDatePage = { ...capturePage, capturedAt: "not-a-date" } as unknown as PageContext;
  const badDateId = await makeContact("Bad Date Person", "https://www.linkedin.com/in/grace");
  const badDateResult = await captureContactProfile(USER, { contactId: badDateId, page: badDatePage });
  check("an unparseable capturedAt does not throw — it still saves", badDateResult.saved);

  // --- only an https linkedin.com URL is ever persisted or written onto the contact ------
  const spoofedUrlPage = {
    ...capturePage,
    url: "https://evil.example.com/in/attacker",
    sourceUrl: "https://evil.example.com/in/attacker",
  } as unknown as PageContext;
  const spoofedUrlId = await makeContact("No Url For Spoof Test", null);
  const spoofedResult = await captureContactProfile(USER, { contactId: spoofedUrlId, page: spoofedUrlPage });
  check("a capture from a non-linkedin.com URL still saves the profile itself", spoofedResult.saved);
  const [spoofedRow] = await db
    .select({ linkedinUrl: contacts.linkedinUrl })
    .from(contacts)
    .where(eq(contacts.id, spoofedUrlId));
  check(
    "but the non-linkedin.com URL is never written onto the contact",
    spoofedRow.linkedinUrl === null,
    spoofedRow.linkedinUrl ?? "null"
  );
  const spoofedProfile = await getContactProfile(USER, spoofedUrlId);
  check(
    "and it is never persisted as the profile's sourceUrl either",
    spoofedProfile?.sourceUrl === null,
    spoofedProfile?.sourceUrl ?? "null"
  );

  const confirmed = await captureContactProfile(USER, {
    contactId: bobId,
    page,
    confirmMismatch: true,
  });
  check("an explicit confirmation overrides the guard", confirmed.saved);

  // A contact with no LinkedIn URL is not a mismatch — it is a gap to fill.
  const urllessId = await makeContact("No Url", null);
  const filled = await captureContactProfile(USER, {
    contactId: urllessId,
    page,
  });
  check("a contact with no URL on file accepts the capture", filled.saved);
  const [urlless] = await db
    .select({ linkedinUrl: contacts.linkedinUrl })
    .from(contacts)
    .where(eq(contacts.id, urllessId));
  check(
    "and gets the URL written as part of accepting it",
    urlless.linkedinUrl === "https://www.linkedin.com/in/grace",
    urlless.linkedinUrl ?? "null"
  );

  // --- CRITICAL: a capture that reads zero roles must never erase a stored career --------
  //
  // `readProfileSections` never returns null — a page whose selectors broke (or an
  // unrecovered AI-fallback attempt) yields a TRUTHY `{ parseIncomplete: true,
  // experiences: [] }`. Before the fix, `captureContactProfile`'s `if (!profile)` gate was
  // false for that shape, so execution fell through into `saveContactProfile`, whose
  // transaction unconditionally deletes every stored `contactExperiences` row for the
  // contact and inserts none — reporting `{ saved: true, degraded: false,
  // experienceCount: 0 }` the whole way. This is the regression test: it fails against the
  // old `if (!profile)` condition and passes once the guard also checks
  // `profile.experiences.length === 0`.
  const zeroRoleGuardId = await makeContact(
    "Zero Role Guard",
    "https://www.linkedin.com/in/zeroroleguard"
  );
  await saveContactProfile(USER, zeroRoleGuardId, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/zeroroleguard",
    adapterVersion: "linkedin-2",
    capturedAt: new Date("2026-08-01T00:00:00Z"),
    warnings: [],
    headline: "A career that must survive",
    about: "This must not be erased by a broken capture.",
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "Existing Corp", title: "Engineer", startYear: 2015,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  });
  const beforeZeroRoleGuard = await getContactProfile(USER, zeroRoleGuardId);
  check(
    "the career is stored before the broken capture",
    beforeZeroRoleGuard?.experiences.length === 1
  );

  const zeroRolePage = {
    ...capturePage,
    url: "https://www.linkedin.com/in/zeroroleguard",
    sourceUrl: "https://www.linkedin.com/in/zeroroleguard",
    // Empty blob: `fallbackParse` bails out before ever asking whether the user has an AI
    // key, so this stays a pure database test with no network involved.
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    profile: {
      headline: null,
      about: null,
      skills: [],
      certifications: [],
      volunteering: [],
      publications: [],
      parseIncomplete: true,
      experiences: [],
    },
  } as unknown as PageContext;

  const zeroRoleResult = await captureContactProfile(USER, {
    contactId: zeroRoleGuardId,
    page: zeroRolePage,
  });
  check(
    "a capture that reads zero roles degrades instead of silently saving an empty profile",
    zeroRoleResult.saved === false &&
      zeroRoleResult.degraded === true &&
      zeroRoleResult.experienceCount === 0,
    JSON.stringify(zeroRoleResult)
  );

  const afterZeroRoleGuard = await getContactProfile(USER, zeroRoleGuardId);
  check(
    "the stored career survives a capture that read zero roles",
    afterZeroRoleGuard?.experiences.length === 1 &&
      afterZeroRoleGuard.experiences[0].organization === "Existing Corp",
    JSON.stringify(afterZeroRoleGuard?.experiences.map((e) => e.organization))
  );
  check(
    "the stored profile prose survives too, not just the experience rows",
    afterZeroRoleGuard?.about === "This must not be erased by a broken capture.",
    afterZeroRoleGuard?.about ?? "null"
  );

  // --- an all-whitespace organization must not wipe a stored career ----------------
  //
  // Regression for the hole the Task 10 caller-side guard could not see. The guard counts
  // what came off the wire; `saveContactProfile` counts the rows it is about to write, and
  // `"   "` is one experience to the first and zero rows to the second. Before the fix
  // this sequence reported `{written:true}` and left the contact with no experience rows
  // at all.
  const whitespaceId = await makeContact("Whit Space", "https://www.linkedin.com/in/whit");
  const realCareer: IncomingProfile = {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/whit",
    adapterVersion: "linkedin-2",
    capturedAt: new Date("2026-08-01T00:00:00Z"),
    warnings: [],
    headline: "Someone with a career",
    about: "This must survive a whitespace capture.",
    skills: [], certifications: [], volunteering: [], publications: [],
    experiences: [
      { kind: "role", organization: "Real Employer", title: "Engineer", startYear: 2015,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  };
  await saveContactProfile(USER, whitespaceId, realCareer);
  check(
    "the career is stored before the whitespace capture",
    (await getContactProfile(USER, whitespaceId))?.experiences.length === 1
  );

  const whitespaceResult = await saveContactProfile(USER, whitespaceId, {
    ...realCareer,
    capturedAt: new Date("2026-08-02T00:00:00Z"),
    experiences: [
      { kind: "role", organization: "   ", title: "Engineer", startYear: 2020,
        startMonth: null, endYear: null, endMonth: null, isCurrent: true, location: null,
        description: null, fieldOfStudy: null },
    ],
  });
  check(
    "a capture whose only organization is whitespace is refused as empty",
    whitespaceResult.written === false && whitespaceResult.reason === "empty",
    JSON.stringify(whitespaceResult)
  );
  const afterWhitespace = await getContactProfile(USER, whitespaceId);
  check(
    "the stored career survives an all-whitespace capture",
    afterWhitespace?.experiences.length === 1 &&
      afterWhitespace.experiences[0].organization === "Real Employer",
    JSON.stringify(afterWhitespace?.experiences.map((e) => e.organization))
  );

  // The same value must also be rejected one layer earlier, at the wire schema, so it
  // never gets counted as an experience by any caller in the first place.
  check(
    "the wire schema rejects a whitespace-only organization",
    pageExperienceSchema.safeParse({
      kind: "role", organization: "   ", title: null, fieldOfStudy: null, location: null,
      description: null, startYear: null, startMonth: null, endYear: null, endMonth: null,
      isCurrent: false,
    }).success === false
  );
  check(
    "the wire schema trims a padded organization rather than storing the padding",
    pageExperienceSchema.safeParse({
      kind: "role", organization: "  Acme  ", title: null, fieldOfStudy: null,
      location: null, description: null, startYear: null, startMonth: null, endYear: null,
      endMonth: null, isCurrent: false,
    }).data?.organization === "Acme"
  );

  // --- the write path must use an API the PRODUCTION driver actually has -------------
  //
  // `getDb()` returns the drizzle neon-http instance whenever DATABASE_URL is set, i.e.
  // always in production, and that driver's `transaction()` throws unconditionally. The
  // smoke suite deletes DATABASE_URL, so every script here runs on PGlite, where a
  // transaction works — which is exactly how a 100%-dead-in-production write path passed
  // the whole suite. These two checks are the pin, and neither needs a live connection.
  const source = readFileSync("src/lib/contact-profile.ts", "utf8");
  check(
    "saveContactProfile's write path does not call .transaction() — neon-http has none",
    !/\.transaction\s*\(/.test(source),
    "src/lib/contact-profile.ts calls .transaction(); use runAtomicWrite from @/db"
  );
  check(
    "saveContactProfile writes through runAtomicWrite",
    /runAtomicWrite\s*\(/.test(source)
  );

  // Driver-level, no network: constructing the neon-http instance against a URL that is
  // never dialled is enough to inspect what the driver offers.
  const fakeNeon = drizzleNeon(neon("postgres://u:p@example.invalid/db"), { schema });
  check(
    "the neon-http driver exposes batch()",
    typeof (fakeNeon as unknown as { batch?: unknown }).batch === "function"
  );
  let transactionError = "";
  try {
    await (fakeNeon as unknown as { transaction: (f: () => Promise<void>) => Promise<void> })
      .transaction(async () => {});
  } catch (error) {
    transactionError = error instanceof Error ? error.message : String(error);
  }
  check(
    "the neon-http driver's transaction() throws before it ever reaches the network",
    transactionError === "No transactions support in neon-http driver",
    transactionError || "it did not throw"
  );
  // An empty statement list returns early on the batch branch and opens a transaction on
  // the PGlite branch — so this resolving against a neon-http instance proves the
  // dispatch, again with no connection attempted.
  let dispatchError = "";
  try {
    await runAtomicWrite(fakeNeon as unknown as Awaited<ReturnType<typeof getDb>>, () => []);
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : String(error);
  }
  check(
    "runAtomicWrite dispatches a neon-http instance to batch, not to transaction",
    dispatchError === "",
    dispatchError
  );

  console.log("\ncontact profile storage: OK");
}

run(main);
