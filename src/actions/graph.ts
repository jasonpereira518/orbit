"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { listActiveGoalTexts } from "@/actions/goals";
import { requireUserId, getCurrentUserProfile } from "@/lib/auth";
import { computeCloseness } from "@/lib/closeness";

export async function getGraphData() {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile();
  const db = await getDb();

  const [rows, goalTexts] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      with: { contactTags: { with: { tag: true } } },
    }),
    listActiveGoalTexts(userId),
  ]);

  const graphContacts = rows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    const breakdown = computeCloseness({ ...c, tags }, goalTexts);
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName,
      company: c.company,
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
      notes: c.notes,
      sharedInterests: c.sharedInterests,
    };
  });

  const companies = [
    ...new Set(rows.map((c) => c.company).filter(Boolean)),
  ] as string[];

  const tags = [
    ...new Set(rows.flatMap((c) => c.contactTags.map((ct) => ct.tag.name))),
  ];

  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of graphContacts) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
  }

  // Layout (nodes/edges) is computed client-side in NetworkGraph from contacts.
  return {
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
