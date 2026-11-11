/**
 * Smart Opportunities Engine
 *
 * Synthesizes notes, ideas, and topics across DIFFERENT people in your network
 * and draws them together with your own goals and progress.
 *
 * Connects the dots where:
 * 1. Mutual Need & Offering: Contact A needs something that Contact B offers or specializes in.
 * 2. Shared Frontier: Contact A and Contact B are exploring complementary ideas or problems.
 * 3. Goal Catalyst: A connection, collaboration, or insight between two people directly
 *    advances your active goal and current milestone progress.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb } from "@/db";
import {
  contacts,
  interactions,
  smartOpportunities,
  userGoals,
  type SmartOpportunity,
  type SmartOpportunityContactExcerpt,
  type SmartOpportunityImpact,
  type SmartOpportunityStatus,
  type SmartOpportunityType,
} from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { listActiveGoalsForUser } from "@/lib/user-goals";

/**
 * Deterministic hash ensuring idempotent opportunity generation.
 */
export function buildSmartOpportunityItemHash(
  userId: string,
  goalId: string | null,
  contactIds: string[],
  title: string
): string {
  const sortedIds = [...contactIds].sort().join(",");
  const normalizedTitle = title.trim().toLowerCase();
  return createHash("sha256")
    .update(`${userId}|${goalId ?? "none"}|${sortedIds}|${normalizedTitle}`)
    .digest("hex");
}

export type CandidateContactNote = {
  contactId: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
  topics: string[];
  notes: string[];
  actionItems: string[];
};

export type SynthesizedOpportunityCandidate = {
  title: string;
  opportunityType: SmartOpportunityType;
  goalId: string | null;
  goalText: string | null;
  synthesisRationale: string;
  suggestedAction: string;
  confidenceScore: number;
  impactScore: SmartOpportunityImpact;
  relatedContactIds: string[];
  contactExcerpts: SmartOpportunityContactExcerpt[];
};

/**
 * Extracts candidate notes, topics, and ideas across recent contact interactions.
 */
export async function loadNetworkIdeaCandidates(
  userId: string,
  options: { limitContacts?: number; maxDays?: number } = {}
): Promise<CandidateContactNote[]> {
  const db = await getDb();
  const limitContacts = options.limitContacts ?? 40;
  const maxDays = options.maxDays ?? 180;
  const cutoff = new Date(Date.now() - maxDays * 86_400_000);

  // 1. Fetch recent contacts with interaction notes
  const recentInteractions = await db
    .select({
      contactId: interactions.contactId,
      rawNotes: interactions.rawNotes,
      aiSummary: interactions.aiSummary,
      topics: interactions.topics,
      actionItems: interactions.actionItems,
      date: interactions.interactionDate,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      company: contacts.company,
      title: contacts.title,
      contactNotes: contacts.notes,
    })
    .from(interactions)
    .innerJoin(contacts, eq(interactions.contactId, contacts.id))
    .where(
      and(
        eq(interactions.userId, userId),
        eq(contacts.userId, userId),
        sql`${interactions.interactionDate} >= ${cutoff}`
      )
    )
    .orderBy(desc(interactions.interactionDate))
    .limit(limitContacts * 4);

  // Group by contact
  const byContact = new Map<string, CandidateContactNote>();
  for (const row of recentInteractions) {
    if (!row.contactId) continue;
    let entry = byContact.get(row.contactId);
    if (!entry) {
      entry = {
        contactId: row.contactId,
        fullName: row.fullName,
        preferredName: row.preferredName,
        company: row.company,
        title: row.title,
        topics: [],
        notes: [],
        actionItems: [],
      };
      if (row.contactNotes?.trim()) {
        entry.notes.push(row.contactNotes.trim());
      }
      byContact.set(row.contactId, entry);
    }

    if (row.rawNotes?.trim() && !entry.notes.includes(row.rawNotes.trim())) {
      entry.notes.push(row.rawNotes.trim());
    }
    if (row.aiSummary?.trim() && !entry.notes.includes(row.aiSummary.trim())) {
      entry.notes.push(row.aiSummary.trim());
    }
    if (Array.isArray(row.topics)) {
      for (const t of row.topics) {
        if (typeof t === "string" && t.trim() && !entry.topics.includes(t.trim().toLowerCase())) {
          entry.topics.push(t.trim().toLowerCase());
        }
      }
    }
    if (Array.isArray(row.actionItems)) {
      for (const a of row.actionItems) {
        if (typeof a === "string" && a.trim() && !entry.actionItems.includes(a.trim())) {
          entry.actionItems.push(a.trim());
        }
      }
    }
  }

  return Array.from(byContact.values()).slice(0, limitContacts);
}

/**
 * Deterministic heuristic synthesis that pairs contacts whose notes or topics align
 * and matches them against user goals and progress.
 */
export function synthesizeOpportunitiesHeuristic(
  goals: Array<{ id: string; text: string; progress?: string | null; category?: string | null }>,
  contactCandidates: CandidateContactNote[]
): SynthesizedOpportunityCandidate[] {
  if (contactCandidates.length < 2) return [];

  const candidates: SynthesizedOpportunityCandidate[] = [];

  // Need & Offering patterns
  const needPatterns = [
    { regex: /\b(?:looking for|seeking|need|needs|hiring|recruiting|want to find)\s+([^.,;\n]+)/i, label: "seeking" },
    { regex: /\b(?:struggling with|challenge with|bottleneck|trying to understand)\s+([^.,;\n]+)/i, label: "challenge" },
    { regex: /\b(?:interested in|exploring|curious about)\s+([^.,;\n]+)/i, label: "exploring" },
  ];

  const offeringPatterns = [
    { regex: /\b(?:expert in|specializes in|built|building|launched|advises|invests in)\s+([^.,;\n]+)/i, label: "specialty" },
    { regex: /\b(?:can introduce|offered to connect|knows people in|happy to help with)\s+([^.,;\n]+)/i, label: "offering" },
  ];

  for (let i = 0; i < contactCandidates.length; i++) {
    for (let j = i + 1; j < contactCandidates.length; j++) {
      const a = contactCandidates[i];
      const b = contactCandidates[j];
      if (a.contactId === b.contactId) continue;

      const aText = `${a.notes.join(" ")} ${a.actionItems.join(" ")} ${a.title ?? ""} ${a.company ?? ""}`;
      const bText = `${b.notes.join(" ")} ${b.actionItems.join(" ")} ${b.title ?? ""} ${b.company ?? ""}`;

      // 1. Shared topics / keywords
      const commonTopics = a.topics.filter((t) => b.topics.includes(t));

      // 2. Need-Offering match
      let matchDescription = "";
      let oppType: SmartOpportunityType = "collaboration";
      let excerptA = a.notes[0] || a.actionItems[0] || `${a.fullName} at ${a.company || "network"}`;
      let excerptB = b.notes[0] || b.actionItems[0] || `${b.fullName} at ${b.company || "network"}`;

      if (commonTopics.length > 0) {
        oppType = "knowledge_share";
        matchDescription = `Both ${a.fullName} and ${b.fullName} are actively engaged in ${commonTopics.slice(0, 2).join(" & ")}.`;
      }

      // Check needs A -> offering B
      for (const n of needPatterns) {
        const m = aText.match(n.regex);
        if (m && m[1]) {
          const phrase = m[1].toLowerCase().trim();
          if (bText.toLowerCase().includes(phrase.slice(0, 15)) || (b.title && b.title.toLowerCase().includes(phrase.slice(0, 10)))) {
            oppType = "introduction";
            matchDescription = `${a.fullName} is ${n.label} ${m[1].trim()}, while ${b.fullName} (${b.company || b.title || "specialist"}) has direct experience in this area.`;
            excerptA = m[0];
            break;
          }
        }
      }

      // If no match found yet, check needs B -> offering A
      if (!matchDescription) {
        for (const n of needPatterns) {
          const m = bText.match(n.regex);
          if (m && m[1]) {
            const phrase = m[1].toLowerCase().trim();
            if (aText.toLowerCase().includes(phrase.slice(0, 15)) || (a.title && a.title.toLowerCase().includes(phrase.slice(0, 10)))) {
              oppType = "introduction";
              matchDescription = `${b.fullName} is ${n.label} ${m[1].trim()}, while ${a.fullName} (${a.company || a.title || "specialist"}) brings direct domain background.`;
              excerptB = m[0];
              break;
            }
          }
        }
      }

      // If we still don't have a specific description but both have company/domain synergy
      if (!matchDescription && commonTopics.length > 0) {
        matchDescription = `${a.fullName} (${a.company || "domain"}) and ${b.fullName} (${b.company || "domain"}) share adjacent focus on ${commonTopics.join(", ")}.`;
      }

      if (!matchDescription) continue;

      // 3. Align with User Goals and Progress
      let matchedGoal: (typeof goals)[0] | null = null;
      let goalTieIn = "";
      let impact: SmartOpportunityImpact = "medium";
      let confidence = 75;

      const combinedPairText = `${aText} ${bText} ${matchDescription}`.toLowerCase();

      for (const g of goals) {
        const gTextLower = g.text.toLowerCase();
        const pTextLower = (g.progress || "").toLowerCase();

        // Check keyword overlap
        const words = `${gTextLower} ${pTextLower}`
          .split(/\W+/)
          .filter((w) => w.length > 3 && !["with", "from", "that", "this", "your", "have"].includes(w));

        const matchedWords = words.filter((w) => combinedPairText.includes(w));
        if (matchedWords.length >= 2 || (pTextLower && combinedPairText.includes(pTextLower.slice(0, 12)))) {
          matchedGoal = g;
          impact = "high";
          confidence = 88;
          goalTieIn = ` This directly accelerates your goal "${g.text}"${
            g.progress ? ` where your current progress is "${g.progress}"` : ""
          }.`;
          break;
        }
      }

      // Title formulation
      const title =
        oppType === "introduction"
          ? `Introduce ${a.fullName} & ${b.fullName}`
          : oppType === "knowledge_share"
          ? `Connect ${a.fullName} and ${b.fullName} on ${commonTopics[0] || "shared initiatives"}`
          : `Synergy: ${a.fullName} & ${b.fullName}`;

      const suggestedAction =
        oppType === "introduction"
          ? `Offer an introductory email linking ${a.fullName}'s objectives with ${b.fullName}'s background.`
          : `Schedule a follow-up or debrief bringing ${a.fullName}'s insights to ${b.fullName}.`;

      candidates.push({
        title,
        opportunityType: oppType,
        goalId: matchedGoal ? matchedGoal.id : null,
        goalText: matchedGoal ? matchedGoal.text : null,
        synthesisRationale: `${matchDescription}${goalTieIn}`,
        suggestedAction,
        confidenceScore: confidence,
        impactScore: impact,
        relatedContactIds: [a.contactId, b.contactId],
        contactExcerpts: [
          { contactId: a.contactId, contactName: a.fullName, excerpt: excerptA.slice(0, 200) },
          { contactId: b.contactId, contactName: b.fullName, excerpt: excerptB.slice(0, 200) },
        ],
      });
    }
  }

  // Sort by impact and confidence
  return candidates
    .sort((x, y) => {
      const impactScore = (s: SmartOpportunityImpact) => (s === "critical" ? 3 : s === "high" ? 2 : 1);
      return impactScore(y.impactScore) - impactScore(x.impactScore) || y.confidenceScore - x.confidenceScore;
    })
    .slice(0, 8);
}

/**
 * AI-assisted synthesis connecting dots across multiple contacts with user goals & progress.
 */
export async function synthesizeOpportunitiesWithAI(
  userId: string,
  goals: Array<{ id: string; text: string; progress?: string | null; category?: string | null }>,
  contactCandidates: CandidateContactNote[]
): Promise<SynthesizedOpportunityCandidate[]> {
  if (contactCandidates.length < 2) return [];

  const candidatePayload = contactCandidates.slice(0, 15).map((c) => ({
    id: c.contactId,
    name: c.fullName,
    company: c.company || "N/A",
    title: c.title || "N/A",
    topics: c.topics.slice(0, 4),
    recentNotes: c.notes.slice(0, 2).map((n) => n.slice(0, 200)),
  }));

  const goalsPayload = goals.map((g) => ({
    id: g.id,
    goal: g.text,
    currentProgress: g.progress || "In progress",
  }));

  const prompt = `You are a strategic networking intelligence analyst.
Analyze the following contacts, their recent notes/topics, and the user's active goals and progress.
Identify 1 to 4 smart, high-leverage opportunities that DRAW TOGETHER notes or ideas from at least TWO DIFFERENT people to accelerate the user's goals and progress.

User Goals & Current Progress:
${JSON.stringify(goalsPayload, null, 2)}

Contacts & Recent Notes/Ideas:
${JSON.stringify(candidatePayload, null, 2)}

Return a JSON array of synthesized opportunities with this exact schema:
[
  {
    "title": "Short punchy title (e.g. Introduce Alice & Bob for AI Benchmark Partnership)",
    "opportunity_type": "introduction" | "collaboration" | "deal" | "knowledge_share" | "advisory" | "other",
    "goal_id": "matched goal id from above, or null",
    "synthesis_rationale": "Clear explanation of how Person A's idea/note and Person B's idea/note connect and directly push the user's goal progress forward",
    "suggested_action": "Specific next move the user should take (e.g. Warm intro email, sharing research, setting up joint call)",
    "confidence_score": 70-95,
    "impact_score": "critical" | "high" | "medium",
    "related_contact_ids": ["contact_id_1", "contact_id_2"],
    "contact_excerpts": [
      { "contact_id": "contact_id_1", "contact_name": "Name 1", "excerpt": "verbatim or concise quote" },
      { "contact_id": "contact_id_2", "contact_name": "Name 2", "excerpt": "verbatim or concise quote" }
    ]
  }
]`;

  try {
    const raw = await completeJson(userId, {
      operation: "smart_opportunities.synthesize",
      system: "You synthesize high-value cross-network opportunities linking multiple people's ideas to a user's goals. Output valid JSON only.",
      user: prompt,
      temperature: 0.2,
    });

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const goalsById = new Map(goals.map((g) => [g.id, g.text]));

    return parsed.map((item: any) => ({
      title: String(item.title || "Cross-network Opportunity"),
      opportunityType: (item.opportunity_type as SmartOpportunityType) || "introduction",
      goalId: item.goal_id && goalsById.has(item.goal_id) ? item.goal_id : null,
      goalText: item.goal_id ? goalsById.get(item.goal_id) || null : null,
      synthesisRationale: String(item.synthesis_rationale || ""),
      suggestedAction: String(item.suggested_action || ""),
      confidenceScore: typeof item.confidence_score === "number" ? Math.min(100, Math.max(0, item.confidence_score)) : 85,
      impactScore: (item.impact_score as SmartOpportunityImpact) || "high",
      relatedContactIds: Array.isArray(item.related_contact_ids) ? item.related_contact_ids : [],
      contactExcerpts: Array.isArray(item.contact_excerpts)
        ? item.contact_excerpts.map((ex: any) => ({
            contactId: String(ex.contact_id || ""),
            contactName: String(ex.contact_name || ""),
            excerpt: String(ex.excerpt || ""),
          }))
        : [],
    }));
  } catch {
    // If AI completion fails or is unavailable, fallback to deterministic synthesis
    return [];
  }
}

/**
 * Runs synthesis and persists newly discovered opportunities for a user.
 */
export async function synthesizeAndPersistSmartOpportunities(
  userId: string,
  options: { preferAi?: boolean } = {}
): Promise<{ count: number; opportunities: SmartOpportunity[] }> {
  const db = await getDb();
  const goals = await listActiveGoalsForUser(userId);
  const contacts = await loadNetworkIdeaCandidates(userId);

  if (contacts.length < 2) {
    return { count: 0, opportunities: [] };
  }

  // 1. Synthesize candidates
  let candidates: SynthesizedOpportunityCandidate[] = [];
  if (options.preferAi) {
    candidates = await synthesizeOpportunitiesWithAI(userId, goals, contacts);
  }

  if (candidates.length === 0) {
    candidates = synthesizeOpportunitiesHeuristic(goals, contacts);
  }

  if (candidates.length === 0) {
    return { count: 0, opportunities: [] };
  }

  // 2. Insert with itemHash deduplication
  const inserted: SmartOpportunity[] = [];
  for (const cand of candidates) {
    const itemHash = buildSmartOpportunityItemHash(
      userId,
      cand.goalId,
      cand.relatedContactIds,
      cand.title
    );

    const [row] = await db
      .insert(smartOpportunities)
      .values({
        userId,
        goalId: cand.goalId,
        title: cand.title,
        opportunityType: cand.opportunityType,
        status: "open",
        synthesisRationale: cand.synthesisRationale,
        suggestedAction: cand.suggestedAction,
        confidenceScore: cand.confidenceScore,
        impactScore: cand.impactScore,
        relatedContactIds: cand.relatedContactIds,
        contactExcerpts: cand.contactExcerpts,
        itemHash,
      })
      .onConflictDoNothing()
      .returning();

    if (row) {
      inserted.push(row);
    }
  }

  return { count: inserted.length, opportunities: inserted };
}

/**
 * Lists smart opportunities for a user.
 */
export async function listSmartOpportunitiesForUser(
  userId: string,
  options: {
    status?: SmartOpportunityStatus;
    goalId?: string;
    contactId?: string;
    limit?: number;
  } = {}
): Promise<SmartOpportunity[]> {
  const db = await getDb();
  const limit = options.limit ?? 20;

  const conditions = [eq(smartOpportunities.userId, userId)];
  if (options.status) {
    conditions.push(eq(smartOpportunities.status, options.status));
  } else {
    // Default: show open and in_progress
    conditions.push(inArray(smartOpportunities.status, ["open", "in_progress"]));
  }

  if (options.goalId) {
    conditions.push(eq(smartOpportunities.goalId, options.goalId));
  }

  const rows = await db
    .select()
    .from(smartOpportunities)
    .where(and(...conditions))
    .orderBy(desc(smartOpportunities.createdAt))
    .limit(limit);

  if (options.contactId) {
    return rows.filter((r) => Array.isArray(r.relatedContactIds) && r.relatedContactIds.includes(options.contactId!));
  }

  return rows;
}

/**
 * Updates status of a smart opportunity (e.g. 'accepted', 'in_progress', 'dismissed').
 */
export async function updateSmartOpportunityStatusForUser(
  userId: string,
  id: string,
  status: SmartOpportunityStatus
): Promise<SmartOpportunity | null> {
  const db = await getDb();
  const [updated] = await db
    .update(smartOpportunities)
    .set({
      status,
      updatedAt: new Date(),
      closedAt: status === "accepted" || status === "dismissed" ? new Date() : null,
    })
    .where(and(eq(smartOpportunities.id, id), eq(smartOpportunities.userId, userId)))
    .returning();

  return updated ?? null;
}
