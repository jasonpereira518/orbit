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

  console.log("\ncontact profile storage: OK");
}

run(main);
