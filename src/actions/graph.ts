"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId, getCurrentUserProfile } from "@/lib/auth";
import { buildHybridGraphLayout } from "@/lib/graph-layout";

export async function getGraphData() {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile();
  const db = await getDb();

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    with: { contactTags: { with: { tag: true } } },
  });

  const graphContacts = rows.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    preferredName: c.preferredName,
    company: c.company,
    title: c.title,
    relationshipScore: c.relationshipScore,
    lastInteractionAt: c.lastInteractionAt,
    nextFollowUpAt: c.nextFollowUpAt,
    tags: c.contactTags.map((ct) => ct.tag.name),
    aiSummary: c.aiSummary,
    keyFacts: c.keyFacts,
    howMet: c.howMet,
    notes: c.notes,
    sharedInterests: c.sharedInterests,
  }));

  const { nodes, edges } = buildHybridGraphLayout(
    graphContacts,
    profile?.name || "You"
  );

  const companies = [
    ...new Set(rows.map((c) => c.company).filter(Boolean)),
  ] as string[];

  const tags = [
    ...new Set(rows.flatMap((c) => c.contactTags.map((ct) => ct.tag.name))),
  ];

  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of rows) {
    const s = Math.min(5, Math.max(1, c.relationshipScore || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
  }

  return {
    nodes,
    edges,
    contacts: graphContacts,
    companies,
    tags,
    userId,
    summary: {
      total: rows.length,
      companyCount: companies.length,
      scoreCounts,
      userName: profile?.name || "You",
    },
  };
}
