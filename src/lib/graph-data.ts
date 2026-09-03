import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, userGoals, userSettings } from "@/db/schema";
import type { UserProfile } from "@/lib/auth";
import { closenessTier } from "@/lib/closeness";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";

/**
 * The constellation payload, as a plain function of `userId`.
 *
 * Lives here rather than in `src/actions/graph.ts` so the query-budget smoke test can
 * call it without a Clerk session or a request scope — the server action is a thin
 * wrapper that resolves the user and hands over the profile lookup as a promise.
 */
export type GraphCluster = {
  /** @deprecated use `name` — kept for UI that keyed on company */
  company: string;
  id: string;
  name: string;
  kind: "company" | "school" | "other";
  count: number;
  contactIds: string[];
};

export type UserSocialLinks = {
  linkedin?: string;
  twitter?: string;
  github?: string;
  website?: string;
};

export async function loadGraphData(
  userId: string,
  options: { profile: Promise<UserProfile | null> | UserProfile | null }
) {
  const db = await getDb();

  // Promise.resolve pins a single execution: a drizzle query builder is a lazy
  // thenable that re-runs on every await, so handing the bare builder to the
  // cohort would quietly issue the same scan twice.
  const contactRowsPromise = Promise.resolve(
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        company: true,
        school: true,
        title: true,
        relationshipScore: true,
        statedCloseness: true,
        lastInteractionAt: true,
        firstInteractionAt: true,
        nextFollowUpAt: true,
        aiSummary: true,
        keyFacts: true,
        howMet: true,
        metContext: true,
        dateMet: true,
        // Omit notes (heavy) from graph payload
        notes: false,
        sharedInterests: true,
        email: true,
        phone: true,
        linkedinUrl: true,
        website: true,
        // Never the column itself — base64 up to 120 KB per row. See contact-avatar-sql.ts.
        profileImageUrl: false,
        createdAt: true,
        industry: true,
      },
      extras: { avatarUrl: clientAvatarUrlSql.as("avatar_url") },
      with: { contactTags: { with: { tag: true } } },
    })
  );

  const [rows, goals, settings, closenessCohort] = await Promise.all([
    contactRowsPromise,
    db.query.userGoals.findMany({
      where: eq(userGoals.userId, userId),
      orderBy: [desc(userGoals.createdAt)],
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    }),
    // Donates the scan above rather than repeating it.
    getClosenessCohort(userId, contactRowsPromise),
  ]);

  const graphContacts = rows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    const breakdown = closenessCohort.byId.get(c.id);
    const dormant = isCometContact(c.lastInteractionAt);
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName,
      company: c.company,
      school: c.school,
      title: c.title,
      relationshipScore: c.relationshipScore,
      closeness: breakdown?.closeness ?? 0,
      closenessTier: breakdown?.tier ?? ("outer" as const),
      orbitScore: breakdown?.orbitScore ?? 1,
      lastInteractionAt: c.lastInteractionAt,
      hasLoggedInteraction: closenessCohort.interactedIds.has(c.id),
      nextFollowUpAt: c.nextFollowUpAt,
      tags,
      aiSummary: c.aiSummary,
      keyFacts: c.keyFacts,
      howMet: c.howMet,
      metContext: c.metContext,
      dateMet: c.dateMet,
      notes: null as string | null,
      sharedInterests: c.sharedInterests,
      email: c.email,
      phone: c.phone,
      linkedinUrl: c.linkedinUrl,
      website: c.website,
      profileImageUrl: c.avatarUrl,
      dormant,
    };
  });

  const { clusters: built } = buildConstellationClusters(graphContacts);
  const clusters: GraphCluster[] = toNamedGraphClusters(built);

  const companies = [
    ...new Set(
      graphContacts.map((c) => (c.company || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  const schools = [
    ...new Set(
      graphContacts.map((c) => (c.school || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  const tags = [
    ...new Set(rows.flatMap((c) => c.contactTags.map((ct) => ct.tag.name))),
  ];

  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let dormantCount = 0;
  let overdueCount = 0;
  // Counted from the absolute score, not from the rings above: rings are quota
  // shares, so ring 4 + ring 5 is a fixed 22% of any network and would report
  // the same "strong ties" number however warm or cold things actually are.
  let strongTies = 0;
  for (const c of graphContacts) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
    const raw = closenessCohort.byId.get(c.id)?.raw;
    if (raw != null && closenessTier(raw) !== "outer") strongTies += 1;
    if (c.dormant) dormantCount += 1;
    if (c.nextFollowUpAt && new Date(c.nextFollowUpAt).getTime() < Date.now()) {
      overdueCount += 1;
    }
  }

  const socialLinks = (settings?.socialLinks || {}) as UserSocialLinks;
  // Awaited last so the Clerk profile round trip overlaps the scan, not precedes it.
  const profile = await options.profile;

  return {
    contacts: graphContacts,
    companies,
    schools,
    tags,
    clusters,
    userId,
    summary: {
      total: rows.length,
      companyCount: companies.length,
      scoreCounts,
      strongTies,
      dormantCount,
      overdueCount,
      userName: profile?.name || "You",
      userImageUrl: profile?.imageUrl || null,
      userEmail: profile?.email || null,
      socialLinks,
      goals: goals
        .filter((g) => g.active === 1)
        .map((g) => ({ id: g.id, text: g.text })),
    },
  };
}

