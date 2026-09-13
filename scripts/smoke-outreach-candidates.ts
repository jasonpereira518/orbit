/**
 * Candidates (spec §5.3, §7.3 step 4). The same person found twice is one prospect with two
 * pieces of evidence; a name-only resemblance is a review suggestion, never a merge; merging
 * never overwrites what we already knew; and the three flags — already a contact, contacted
 * in another campaign, suppressed — are set on insert.
 *
 * Run: npx tsx scripts/smoke-outreach-candidates.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { evidenceHash, upsertCandidate } from "../src/lib/outreach/discovery/candidates";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-candidates-user";
const hit = (url: string, title: string) => ({
  kind: "search_result" as const, provider: "brave" as const, url, title, snippet: title,
});

async function main() {
  const db = await getDb();
  const [campaign] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Now", generation: 2 }).returning();
  const [older] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Spring intros" }).returning();

  const first = await upsertCandidate(USER, campaign.id, {
    fullName: "Jane Doe", headline: "Head of Partnerships", company: "Ramp", location: null,
    linkedinUrl: "https://uk.linkedin.com/in/Jane-Doe?trk=x", origin: "discovered",
    evidence: [hit("https://uk.linkedin.com/in/Jane-Doe", "Jane Doe - Head of Partnerships - Ramp")],
  });
  const second = await upsertCandidate(USER, campaign.id, {
    fullName: "Jane Doe", headline: "Partnerships", company: "Different Co", location: "New York",
    linkedinUrl: "https://www.linkedin.com/in/jane-doe", origin: "discovered",
    evidence: [hit("https://www.linkedin.com/in/jane-doe", "Jane Doe – Ramp")],
  });
  check("the same profile found twice is one prospect", first.created && !second.created && first.prospectId === second.prospectId);
  const [jane] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, first.prospectId));
  check("merging fills gaps", jane.location === "New York");
  check("merging never overwrites known fields", jane.company === "Ramp" && jane.headline === "Head of Partnerships");
  check("the stored URL is canonical", jane.linkedinUrl === "https://www.linkedin.com/in/jane-doe");
  check("user_id is set", jane.userId === USER);
  const evidence = await db.select().from(schema.outreachEvidence).where(eq(schema.outreachEvidence.prospectId, jane.id));
  check("both sightings are kept as evidence", evidence.length === 2);
  await upsertCandidate(USER, campaign.id, {
    fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe", origin: "discovered",
    evidence: [hit("https://www.linkedin.com/in/jane-doe", "Jane Doe – Ramp")],
  });
  check("identical evidence is not stored twice",
    (await db.select().from(schema.outreachEvidence).where(eq(schema.outreachEvidence.prospectId, jane.id))).length === 2);

  const lookalike = await upsertCandidate(USER, campaign.id, {
    fullName: "Jane  Doe", headline: "BD", company: "ramp", linkedinUrl: "https://www.linkedin.com/in/jane-doe-ramp-2",
    origin: "discovered", evidence: [hit("https://www.linkedin.com/in/jane-doe-ramp-2", "Jane Doe - BD - Ramp")],
  });
  check("a same-name same-company person with a different profile is kept separate", lookalike.created && lookalike.prospectId !== jane.id);
  check("…and flagged for review", lookalike.possibleDuplicateOf === jane.id);

  const [contact] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Amir Khan" }).returning();
  await db.insert(schema.contactIdentities).values({ userId: USER, contactId: contact.id, kind: "linkedin_slug", value: "amir-k" });
  const known = await upsertCandidate(USER, campaign.id, {
    fullName: "Amir Khan", linkedinUrl: "https://www.linkedin.com/in/amir-k", origin: "discovered",
    evidence: [hit("https://www.linkedin.com/in/amir-k", "Amir Khan - Plaid")],
  });
  const [amir] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, known.prospectId));
  check("an existing contact is linked and flagged", amir.contactId === contact.id && amir.flags.existingContactId === contact.id);

  await db.insert(schema.outreachProspects).values({
    userId: USER, campaignId: older.id, externalId: "legacy-1", fullName: "Sam Lee",
    linkedinUrl: "https://www.linkedin.com/in/sam-lee", status: "contacted",
  });
  const contacted = await upsertCandidate(USER, campaign.id, {
    fullName: "Sam Lee", linkedinUrl: "https://linkedin.com/in/sam-lee/", origin: "discovered",
    evidence: [hit("https://www.linkedin.com/in/sam-lee", "Sam Lee - Brex")],
  });
  const [sam] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, contacted.prospectId));
  check("someone contacted in another campaign is flagged", sam.flags.previousCampaigns?.[0]?.name === "Spring intros", JSON.stringify(sam.flags));

  await db.insert(schema.outreachSuppressions).values({ userId: USER, kind: "linkedin_slug", value: "opt-out-person", reason: "opted_out" });
  const suppressed = await upsertCandidate(USER, campaign.id, {
    fullName: "Opt Out", linkedinUrl: "https://www.linkedin.com/in/opt-out-person", origin: "discovered",
    evidence: [hit("https://www.linkedin.com/in/opt-out-person", "Opt Out - Somewhere")],
  });
  const [opt] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, suppressed.prospectId));
  check("a suppressed person is flagged", opt.flags.suppressed === "opted_out");

  const identities = await db
    .select()
    .from(schema.outreachIdentities)
    .where(and(eq(schema.outreachIdentities.campaignId, campaign.id), eq(schema.outreachIdentities.prospectId, jane.id)));
  check("identities are stored normalized", identities.length === 1 && identities[0].value === "jane-doe");

  // Evidence hash boundary sensitivity: different title/snippet combos must not collide
  const ev1 = { kind: "search_result" as const, provider: "brave" as const, url: "https://example.com", title: "ab", snippet: "c" };
  const ev2 = { kind: "search_result" as const, provider: "brave" as const, url: "https://example.com", title: "a", snippet: "bc" };
  check("evidence hash is boundary-sensitive", evidenceHash(ev1) !== evidenceHash(ev2));

  console.log("All outreach candidate checks passed.");
}

run(main);
