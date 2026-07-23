"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, userSettings } from "@/db/schema";
import { listActiveGoalTexts, listGoals } from "@/actions/goals";
import { requireUserId, getCurrentUserProfile } from "@/lib/auth";
import { computeCloseness } from "@/lib/closeness";
import { isCometContact } from "@/lib/comet";
import { rebuildContactEmbedding } from "@/lib/search";
import { buildConstellationClusters } from "@/lib/constellation-clusters";

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

export async function getGraphData() {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile();
  const db = await getDb();

  const [rows, goalTexts, goals, settings] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      with: { contactTags: { with: { tag: true } } },
    }),
    listActiveGoalTexts(userId),
    listGoals(),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    }),
  ]);

  const graphContacts = rows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    const breakdown = computeCloseness({ ...c, tags }, goalTexts);
    const dormant = isCometContact(c.lastInteractionAt);
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName,
      company: c.company,
      school: c.school,
      title: c.title,
      relationshipScore: c.relationshipScore,
      closeness: breakdown.closeness,
      closenessTier: breakdown.tier,
      orbitScore: breakdown.orbitScore,
      lastInteractionAt: c.lastInteractionAt,
      nextFollowUpAt: c.nextFollowUpAt,
      tags,
      aiSummary: c.aiSummary,
      keyFacts: c.keyFacts,
      howMet: c.howMet,
      metContext: c.metContext,
      dateMet: c.dateMet,
      notes: c.notes,
      sharedInterests: c.sharedInterests,
      email: c.email,
      phone: c.phone,
      linkedinUrl: c.linkedinUrl,
      website: c.website,
      profileImageUrl: c.profileImageUrl,
      dormant,
    };
  });

  const { clusters: built } = buildConstellationClusters(graphContacts);
  const clusters: GraphCluster[] = built
    .filter((c) => c.kind === "company" || c.kind === "school")
    .map((c) => ({
      id: c.id,
      name: c.name,
      company: c.name,
      kind: c.kind,
      count: c.count,
      contactIds: c.contactIds,
    }));

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
  for (const c of graphContacts) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
    if (c.dormant) dormantCount += 1;
    if (c.nextFollowUpAt && new Date(c.nextFollowUpAt).getTime() < Date.now()) {
      overdueCount += 1;
    }
  }

  const socialLinks = (settings?.socialLinks || {}) as UserSocialLinks;

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

/**
 * Rebuild embeddings in chunks so the client can show progress.
 * Call repeatedly until done === true.
 */
export async function refreshConstellationBatch(input?: {
  offset?: number;
  limit?: number;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const offset = Math.max(0, input?.offset ?? 0);
  const limit = Math.min(20, Math.max(1, input?.limit ?? 8));

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { id: true },
  });
  const total = rows.length;
  const slice = rows.slice(offset, offset + limit);

  let processed = offset;
  for (const row of slice) {
    try {
      await rebuildContactEmbedding(userId, row.id);
    } catch (err) {
      console.error("Embedding rebuild failed", row.id, err);
    }
    processed += 1;
  }

  const done = processed >= total;
  const graph = done ? await getGraphData() : null;

  return {
    total,
    processed,
    done,
    graph,
  };
}
