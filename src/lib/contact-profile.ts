/**
 * The single write path for a captured LinkedIn profile, and the two reads that serve
 * chat and the contact page.
 *
 * Auth-free and DB-only on purpose, the way `src/lib/note-batch-save.ts` is: server
 * actions and extension routes are thin wrappers over this, and
 * `scripts/smoke-contact-profile.ts` drives it against PGlite with no Clerk session.
 *
 * ## Precedence
 *
 * An extension capture is a page the user actually looked at; Apollo is an inference from
 * a third-party dataset. So the extension always wins, and Apollo writes only into a gap
 * or over its own earlier guess.
 *
 * Replacement is wholesale rather than a merge, and the delete is NOT filtered by source.
 * A merge would strand roles that the newest capture no longer shows — LinkedIn's own page
 * is the complete statement of someone's history, so anything absent from it has been
 * removed, and no later capture could ever clear a row a merge preserved.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactExperiences,
  contactProfiles,
  contacts,
  type ContactExperienceKind,
  type ContactProfileSource,
  type ProfileCertification,
  type ProfilePublication,
  type ProfileSkill,
  type ProfileVolunteering,
} from "@/db/schema";
import { normalizeCompanyKey } from "@/lib/company-name";
import { careerLine, orderExperiences } from "@/lib/contact-profile-format";

export type IncomingExperience = {
  kind: ContactExperienceKind;
  organization: string;
  title: string | null;
  fieldOfStudy: string | null;
  location: string | null;
  description: string | null;
  startYear: number | null;
  startMonth: number | null;
  endYear: number | null;
  endMonth: number | null;
  isCurrent: boolean;
};

export type IncomingProfile = {
  source: ContactProfileSource;
  sourceUrl: string | null;
  adapterVersion: string | null;
  capturedAt: Date;
  warnings: string[];
  headline: string | null;
  about: string | null;
  skills: ProfileSkill[];
  certifications: ProfileCertification[];
  volunteering: ProfileVolunteering[];
  publications: ProfilePublication[];
  experiences: IncomingExperience[];
};

export type StoredExperience = IncomingExperience & {
  id: string;
  organizationNormalized: string;
  sortIndex: number;
  source: ContactProfileSource;
};

export type StoredProfile = {
  source: ContactProfileSource;
  sourceUrl: string | null;
  adapterVersion: string | null;
  capturedAt: Date;
  warnings: string[];
  headline: string | null;
  about: string | null;
  skills: ProfileSkill[];
  certifications: ProfileCertification[];
  volunteering: ProfileVolunteering[];
  publications: ProfilePublication[];
  /** Already in display order — callers must not re-sort. */
  experiences: StoredExperience[];
};

/** Longest description we keep per entry. Whole-page prose belongs in `about`. */
const MAX_DESCRIPTION_CHARS = 2000;

function trimmed(value: string | null | undefined, max = 300): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.slice(0, max);
}

/**
 * Whether `incoming` is allowed to overwrite what is already stored.
 *
 * An absent row means anything may write. Otherwise the extension always may, and Apollo
 * may only replace Apollo — deliberately regardless of timestamps, because a fresher
 * inference is still an inference.
 */
function outranks(
  incoming: ContactProfileSource,
  existing: ContactProfileSource | null
): boolean {
  if (existing === null) return true;
  if (incoming === "extension") return true;
  return existing === "apollo";
}

export async function saveContactProfile(
  userId: string,
  contactId: string,
  incoming: IncomingProfile
): Promise<{ written: boolean; reason: "saved" | "outranked" }> {
  const db = await getDb();

  const existing = await db.query.contactProfiles.findFirst({
    where: and(
      eq(contactProfiles.userId, userId),
      eq(contactProfiles.contactId, contactId)
    ),
    columns: { id: true, source: true },
  });

  if (!outranks(incoming.source, existing?.source ?? null)) {
    return { written: false, reason: "outranked" };
  }

  // Ordered on the way in so `sort_index` is the display order, not the scrape order.
  // Every later read can then trust the column instead of re-deriving the rule.
  const ordered = orderExperiences(
    incoming.experiences.map((entry, index) => ({ ...entry, sortIndex: index }))
  );

  const rows = ordered
    .map((entry, index) => {
      const organization = trimmed(entry.organization);
      if (!organization) return null;
      return {
        userId,
        contactId,
        kind: entry.kind,
        organization,
        organizationNormalized: normalizeCompanyKey(organization),
        title: trimmed(entry.title),
        fieldOfStudy: trimmed(entry.fieldOfStudy),
        location: trimmed(entry.location),
        description: trimmed(entry.description, MAX_DESCRIPTION_CHARS),
        startYear: entry.startYear,
        startMonth: entry.startMonth,
        endYear: entry.endYear,
        endMonth: entry.endMonth,
        isCurrent: entry.isCurrent,
        sortIndex: index,
        source: incoming.source,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const profileValues = {
    userId,
    contactId,
    headline: trimmed(incoming.headline),
    about: trimmed(incoming.about, 8000),
    skills: incoming.skills,
    certifications: incoming.certifications,
    volunteering: incoming.volunteering,
    publications: incoming.publications,
    source: incoming.source,
    sourceUrl: trimmed(incoming.sourceUrl, 500),
    adapterVersion: trimmed(incoming.adapterVersion, 60),
    warnings: incoming.warnings,
    capturedAt: incoming.capturedAt,
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(contactProfiles)
      .values(profileValues)
      .onConflictDoUpdate({
        target: [contactProfiles.userId, contactProfiles.contactId],
        set: profileValues,
      });

    // Not filtered by source: see the header. The newest capture is the whole truth.
    await tx
      .delete(contactExperiences)
      .where(
        and(
          eq(contactExperiences.userId, userId),
          eq(contactExperiences.contactId, contactId)
        )
      );
    if (rows.length) await tx.insert(contactExperiences).values(rows);

    // The profile feeds `buildContactEmbeddingContent`, so its stored vector is now
    // behind. The existing backfill claims anything flagged here.
    await tx
      .update(contacts)
      .set({ embeddingStaleAt: new Date() })
      .where(and(eq(contacts.userId, userId), eq(contacts.id, contactId)));
  });

  return { written: true, reason: "saved" };
}

export async function getContactProfile(
  userId: string,
  contactId: string
): Promise<StoredProfile | null> {
  const db = await getDb();
  const [profile, entries] = await Promise.all([
    db.query.contactProfiles.findFirst({
      where: and(
        eq(contactProfiles.userId, userId),
        eq(contactProfiles.contactId, contactId)
      ),
    }),
    db.query.contactExperiences.findMany({
      where: and(
        eq(contactExperiences.userId, userId),
        eq(contactExperiences.contactId, contactId)
      ),
      orderBy: (t, { asc }) => [asc(t.sortIndex)],
    }),
  ]);
  if (!profile) return null;

  return {
    source: profile.source,
    sourceUrl: profile.sourceUrl,
    adapterVersion: profile.adapterVersion,
    capturedAt: profile.capturedAt,
    warnings: profile.warnings ?? [],
    headline: profile.headline,
    about: profile.about,
    skills: profile.skills ?? [],
    certifications: profile.certifications ?? [],
    volunteering: profile.volunteering ?? [],
    publications: profile.publications ?? [],
    experiences: entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      organization: e.organization,
      organizationNormalized: e.organizationNormalized,
      title: e.title,
      fieldOfStudy: e.fieldOfStudy,
      location: e.location,
      description: e.description,
      startYear: e.startYear,
      startMonth: e.startMonth,
      endYear: e.endYear,
      endMonth: e.endMonth,
      isCurrent: e.isCurrent,
      sortIndex: e.sortIndex,
      source: e.source,
    })),
  };
}

/**
 * One compact career line per contact, for the contacts a network-wide question
 * retrieved. One query for the whole page of results — never one per contact.
 */
export async function getCareerLines(
  userId: string,
  contactIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!contactIds.length) return out;

  const db = await getDb();
  const rows = await db.query.contactExperiences.findMany({
    where: and(
      eq(contactExperiences.userId, userId),
      inArray(contactExperiences.contactId, contactIds)
    ),
    orderBy: (t, { asc }) => [asc(t.sortIndex)],
  });

  const byContact = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byContact.get(row.contactId);
    if (list) list.push(row);
    else byContact.set(row.contactId, [row]);
  }

  for (const [contactId, entries] of byContact) {
    const line = careerLine(entries);
    if (line) out.set(contactId, line);
  }
  return out;
}
