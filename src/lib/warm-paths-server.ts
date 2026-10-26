import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sharedAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactExperiences, contacts } from "@/db/schema";
import { companyKeySql } from "@/lib/company-name";
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
 * Two statements, both scoped to the user and to the org keys asked for:
 *
 *   1. `contact_experiences` on `contact_experiences_org_idx (user_id, organization_normalized)`
 *      — the index that has existed for this exact question since the table shipped.
 *   2. `contacts.company`, keyed in SQL by `companyKeySql` — the same normalisation as the
 *      org keys. This is the one that actually fires for most users: a LinkedIn CSV import
 *      writes `contacts.company` and no experience rows at all, so querying only the first
 *      source would return almost nothing for a freshly-imported network.
 *
 *      It used to match `companies.name_normalized`, which is `normalizeCompanyName` (trim +
 *      lowercase only) against `normalizeCompanyKey` keys (punctuation folded), so "Meta
 *      Platforms, Inc." never matched. ponytail: the key expression is unindexed, bounded by
 *      `user_id`; add an expression index on it if a large network makes this slow.
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
        profileImageUrl: sql<string | null>`coalesce(${sharedAvatarUrlSql}, ${contacts.profileImageUrl})`,
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
        orgKey: sql<string>`${sql.raw(companyKeySql("contacts.company"))}`,
        orgLabel: sql<string>`contacts.company`,
        roleTitle: contacts.title,
        fullName: contacts.fullName,
        closeness: contacts.closeness,
        relationshipScore: contacts.relationshipScore,
        profileImageUrl: sql<string | null>`coalesce(${sharedAvatarUrlSql}, ${contacts.profileImageUrl})`,
        linkedinUrl: contacts.linkedinUrl,
        email: contacts.email,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          inArray(sql`${sql.raw(companyKeySql("contacts.company"))}`, orgKeys)
        )
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
