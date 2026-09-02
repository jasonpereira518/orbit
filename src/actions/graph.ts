"use server";

import { eq } from "drizzle-orm";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { getDb } from "@/db";
import { contacts, userSettings } from "@/db/schema";
import { listGoals } from "@/actions/goals";
import { getCurrentUserProfile } from "@/lib/auth";
import { closenessTier } from "@/lib/closeness";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { isCometContact } from "@/lib/comet";
import { rebuildContactEmbedding } from "@/lib/search";
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import { clientContactAvatarUrl } from "@/lib/contact-avatar-url";
import { requireUserForSurface } from "@/lib/plan-guards";

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
  const userId = await requireUserForSurface("page.graph");
  const profile = await getCurrentUserProfile();
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
        profileImageUrl: true,
        createdAt: true,
        industry: true,
      },
      with: { contactTags: { with: { tag: true } } },
    })
  );

  const [rows, goals, settings, closenessCohort] = await Promise.all([
    contactRowsPromise,
    listGoals(),
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
      profileImageUrl: clientContactAvatarUrl(c.id, c.profileImageUrl),
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

/**
 * Rebuild embeddings in chunks so the client can show progress.
 * Call repeatedly until done === true.
 */
export async function refreshConstellationBatch(input?: {
  offset?: number;
  limit?: number;
}) {
  const userId = await requireUserForSurface("page.graph");
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
  let failed = 0;
  let firstError: unknown = null;
  let firstFailedId: string | null = null;
  for (const row of slice) {
    try {
      await rebuildContactEmbedding(userId, row.id);
    } catch (err) {
      console.error("Embedding rebuild failed", row.id, err);
      failed += 1;
      if (!firstError) {
        firstError = err;
        firstFailedId = row.id;
      }
    }
    processed += 1;
  }

  // One row per batch, never per contact — per-item error rows are how a diagnostic
  // table becomes a log firehose.
  if (failed > 0) {
    await recordErrorEvent({
      source: ERROR_SOURCES.graphRebuildEmbeddings,
      kind: "batch_partial_failure",
      userId,
      message: firstError,
      context: { failed, batchSize: slice.length, total, sampleContactId: firstFailedId },
    });
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
