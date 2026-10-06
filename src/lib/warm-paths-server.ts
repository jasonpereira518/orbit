import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { companies, contactExperiences, contacts } from "@/db/schema";
import {
  WARM_PATHS_PER_ORG,
  rankWarmPaths,
  type WarmPath,
  type WarmPathCandidate,
} from "@/lib/warm-paths";

/**
 * Fetches the two kinds of evidence that someone in the network is connected to an
 * organisation, and hands them to `rankWarmPaths`.
 *
 * Two indexed statements, both scoped to the user and to the org keys asked for:
 *
 *   1. `contact_experiences` on `contact_experiences_org_idx (user_id, organization_normalized)`
 *      — the index that has existed for this exact question since the table shipped.
 *   2. `contacts` joined to `companies` on `company_id`, matched on `companies.name_normalized`
 *      via `companies_user_name_uidx`. This is the one that actually fires for most users: a
 *      LinkedIn CSV import writes `contacts.company` and no experience rows at all, so
 *      querying only the first source would return almost nothing for a freshly-imported
 *      network.
 *
 * Returns a map keyed by normalised org. An org with nobody behind it is absent rather than
 * present-and-empty, so callers can distinguish "no connection" from "not looked up".
 */
export async function findWarmPaths(
  userId: string,
  orgKeys: string[],
  perOrg: number = WARM_PATHS_PER_ORG
): Promise<Map<string, WarmPath[]>> {
  if (orgKeys.length === 0) return new Map();
  const db = await getDb();

  const [experienceRows, companyRows] = await Promise.all([
    db
      .select({
        contactId: contactExperiences.contactId,
        orgKey: contactExperiences.organizationNormalized,
        orgLabel: contactExperiences.organization,
        isCurrent: contactExperiences.isCurrent,
        roleTitle: contactExperiences.title,
        startYear: contactExperiences.startYear,
        endYear: contactExperiences.endYear,
        fullName: contacts.fullName,
        closeness: contacts.closeness,
        relationshipScore: contacts.relationshipScore,
        profileImageUrl: contacts.profileImageUrl,
        linkedinUrl: contacts.linkedinUrl,
        email: contacts.email,
      })
      .from(contactExperiences)
      .innerJoin(contacts, eq(contacts.id, contactExperiences.contactId))
      .where(
        and(
          eq(contactExperiences.userId, userId),
          inArray(contactExperiences.organizationNormalized, orgKeys)
        )
      ),

    db
      .select({
        contactId: contacts.id,
        orgKey: companies.nameNormalized,
        orgLabel: companies.name,
        roleTitle: contacts.title,
        fullName: contacts.fullName,
        closeness: contacts.closeness,
        relationshipScore: contacts.relationshipScore,
        profileImageUrl: contacts.profileImageUrl,
        linkedinUrl: contacts.linkedinUrl,
        email: contacts.email,
      })
      .from(contacts)
      .innerJoin(companies, eq(companies.id, contacts.companyId))
      .where(
        and(eq(contacts.userId, userId), inArray(companies.nameNormalized, orgKeys))
      ),
  ]);

  const candidates: WarmPathCandidate[] = [
    ...experienceRows.map((r) => ({
      contactId: r.contactId,
      fullName: r.fullName,
      orgKey: r.orgKey,
      orgLabel: r.orgLabel,
      reason: (r.isCurrent ? "works_there" : "worked_there") as WarmPathCandidate["reason"],
      title: r.roleTitle,
      startYear: r.startYear,
      endYear: r.endYear,
      closeness: r.closeness,
      relationshipScore: r.relationshipScore,
      profileImageUrl: r.profileImageUrl,
      linkedinUrl: r.linkedinUrl,
      email: r.email,
    })),
    ...companyRows.map((r) => ({
      contactId: r.contactId,
      fullName: r.fullName,
      orgKey: r.orgKey,
      orgLabel: r.orgLabel,
      reason: "listed_there" as const,
      title: r.roleTitle,
      closeness: r.closeness,
      relationshipScore: r.relationshipScore,
      profileImageUrl: r.profileImageUrl,
      linkedinUrl: r.linkedinUrl,
      email: r.email,
    })),
  ];

  return rankWarmPaths(candidates, perOrg);
}
