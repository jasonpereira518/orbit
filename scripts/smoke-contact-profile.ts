/**
 * The LinkedIn profile store: tables exist, rows cascade with their contact.
 * Later tasks extend this file with precedence, the slug guard, and search.
 *
 * Writes to a throwaway PGlite dir. Run: npx tsx scripts/smoke-contact-profile.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-contact-profile";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-contact-profile";

import { eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { contactExperiences, contactProfiles, contacts } from "../src/db/schema";
import {
  getCareerLines,
  getContactProfile,
  saveContactProfile,
  type IncomingProfile,
} from "../src/lib/contact-profile";

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

  // --- embedding invalidation ---------------------------------------------------
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

  console.log("\ncontact profile storage: OK");
}

run(main);
