import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  contacts,
  interactions,
  reminders,
  userGoals,
} from "@/db/schema";
import { listActiveGoalTexts } from "@/actions/goals";
import { daysAgo } from "@/lib/duplicates";
import { computeNetworkMetrics } from "@/lib/network-metrics";

const AUTO_SUGGESTION_TYPES = [
  "dormant_high_value",
  "post_event",
  "linkedin_thread_quiet",
] as const;

const MAX_AUTO_SUGGESTIONS = 12;

const AUTO_TYPE_PRIORITY: Record<(typeof AUTO_SUGGESTION_TYPES)[number], number> = {
  post_event: 3,
  linkedin_thread_quiet: 2,
  dormant_high_value: 1,
};

function contactDisplayName(c: {
  fullName: string;
  preferredName?: string | null;
}) {
  return (c.preferredName || "").trim() || c.fullName;
}

/** Contacts without a scheduled follow-up are eligible for discovery suggestions. */
function isDiscoveryEligible(c: { nextFollowUpAt: Date | string | null }) {
  return !c.nextFollowUpAt;
}

export async function refreshOutreachSuggestions(userId: string) {
  const db = await getDb();
  const all = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  // Clear pending auto suggestions so we regenerate fresh ones
  // (preserve user-facing AI suggestions like score_bump from enrichment)
  await db
    .delete(aiSuggestions)
    .where(
      and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending"),
        inArray(aiSuggestions.suggestionType, [...AUTO_SUGGESTION_TYPES])
      )
    );

  type Candidate = {
    suggestionType: (typeof AUTO_SUGGESTION_TYPES)[number];
    title: string;
    description: string;
    relatedContactIds: string[];
    confidenceScore: number;
  };

  const candidateByContact = new Map<string, Candidate>();

  function upsertCandidate(contactId: string, candidate: Candidate) {
    const existing = candidateByContact.get(contactId);
    if (!existing) {
      candidateByContact.set(contactId, candidate);
      return;
    }
    const existingPri =
      AUTO_TYPE_PRIORITY[existing.suggestionType as keyof typeof AUTO_TYPE_PRIORITY] ?? 0;
    const nextPri =
      AUTO_TYPE_PRIORITY[candidate.suggestionType] ?? 0;
    if (
      nextPri > existingPri ||
      (nextPri === existingPri &&
        candidate.confidenceScore > existing.confidenceScore)
    ) {
      candidateByContact.set(contactId, candidate);
    }
  }

  const dormantHighValue = all.filter(
    (c) =>
      isDiscoveryEligible(c) &&
      (c.priorityLevel >= 2 || c.relationshipScore >= 4) &&
      daysAgo(c.lastInteractionAt) >= 30
  );
  for (const c of dormantHighValue) {
    const idle = daysAgo(c.lastInteractionAt);
    upsertCandidate(c.id, {
      suggestionType: "dormant_high_value",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `Gone quiet — last touch ${idle} day${idle === 1 ? "" : "s"} ago`,
      relatedContactIds: [c.id],
      confidenceScore: 80,
    });
  }

  const withMessageHistory = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.interactionType, "linkedin_message")
    ),
  });
  const messageStats = new Map<
    string,
    { count: number; last: Date; first: Date }
  >();
  for (const m of withMessageHistory) {
    const d = m.interactionDate || m.createdAt;
    const prev = messageStats.get(m.contactId);
    if (!prev) {
      messageStats.set(m.contactId, { count: 1, last: d, first: d });
    } else {
      prev.count += 1;
      if (d > prev.last) prev.last = d;
      if (d < prev.first) prev.first = d;
    }
  }

  for (const c of all) {
    if (!isDiscoveryEligible(c)) continue;
    const stats = messageStats.get(c.id);
    if (!stats || stats.count < 2) continue;
    const daysSinceLast = daysAgo(stats.last);
    if (daysSinceLast < 14 || daysSinceLast > 90) continue;
    upsertCandidate(c.id, {
      suggestionType: "linkedin_thread_quiet",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `LinkedIn thread went quiet — last activity ${daysSinceLast} days ago`,
      relatedContactIds: [c.id],
      confidenceScore: 78,
    });
  }

  for (const c of all) {
    if (!isDiscoveryEligible(c)) continue;
    if (!c.firstInteractionAt) continue;
    const days = daysAgo(c.firstInteractionAt);
    if (days < 7 || days > 21) continue;
    if (
      c.lastInteractionAt &&
      c.lastInteractionAt.getTime() !== c.firstInteractionAt.getTime()
    ) {
      continue;
    }
    upsertCandidate(c.id, {
      suggestionType: "post_event",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `Recent intro ${days} day${days === 1 ? "" : "s"} ago — no follow-up logged yet`,
      relatedContactIds: [c.id],
      confidenceScore: 85,
    });
  }

  const suggestions = [...candidateByContact.values()]
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, MAX_AUTO_SUGGESTIONS);

  if (suggestions.length) {
    await db.insert(aiSuggestions).values(
      suggestions.map((s) => ({
        userId,
        ...s,
        status: "pending",
      }))
    );
  }

  return suggestions;
}

function followUpCandidateScore(contact: {
  priorityLevel: number;
  relationshipScore: number;
  lastInteractionAt: Date | string | null;
  nextFollowUpAt: Date | string | null;
}) {
  const idleDays = Math.min(daysAgo(contact.lastInteractionAt), 365);
  const idleScore = Number.isFinite(idleDays) ? idleDays / 30 : 2;
  return (
    (contact.priorityLevel || 0) * 4 +
    (contact.relationshipScore || 0) * 2 +
    idleScore -
    (contact.nextFollowUpAt ? 1 : 0)
  );
}

/**
 * Schedule additional due follow-ups from contacts that are not already due —
 * prefers high priority / strong / dormant people.
 */
export async function generateDueFollowUps(userId: string, limit = 8) {
  const db = await getDb();
  const now = new Date();
  const all = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const alreadyDueIds = new Set(
    all
      .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
      .map((c) => c.id)
  );

  const candidates = all
    .filter((c) => !alreadyDueIds.has(c.id))
    .filter((c) => {
      // Skip people with a future follow-up still more than a day away
      if (c.nextFollowUpAt && new Date(c.nextFollowUpAt) > now) {
        const ms = new Date(c.nextFollowUpAt).getTime() - now.getTime();
        if (ms > 24 * 60 * 60 * 1000) return false;
      }
      // Prefer people who have gone quiet or have no follow-up yet
      const idle = daysAgo(c.lastInteractionAt);
      return (
        !c.nextFollowUpAt ||
        idle >= 14 ||
        (c.priorityLevel || 0) >= 2 ||
        (c.relationshipScore || 0) >= 4
      );
    })
    .sort((a, b) => followUpCandidateScore(b) - followUpCandidateScore(a))
    .slice(0, Math.max(1, Math.min(24, limit)));

  let created = 0;
  for (const contact of candidates) {
    const name = contact.preferredName || contact.fullName;
    const title = `Follow up with ${name}`;

    const existing = await db.query.reminders.findFirst({
      where: and(
        eq(reminders.userId, userId),
        eq(reminders.contactId, contact.id),
        eq(reminders.status, "pending")
      ),
    });

    if (existing) {
      await db
        .update(reminders)
        .set({
          title,
          dueDate: now,
          reminderType: "generated",
          actionKind: "follow_up",
          createdBy: "system",
        })
        .where(eq(reminders.id, existing.id));
    } else {
      await db.insert(reminders).values({
        userId,
        contactId: contact.id,
        title,
        description: "Generated from dashboard outreach queue",
        dueDate: now,
        reminderType: "generated",
        actionKind: "follow_up",
        createdBy: "system",
        status: "pending",
      });
    }

    await db
      .update(contacts)
      .set({
        nextFollowUpAt: now,
        followUpStatus: "pending",
        updatedAt: now,
      })
      .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

    created += 1;
  }

  await refreshOutreachSuggestions(userId);
  return { created, contactIds: candidates.map((c) => c.id) };
}

const SUGGESTION_REFRESH_TTL_MS = 30 * 60 * 1000;

async function maybeRefreshOutreachSuggestions(userId: string) {
  const db = await getDb();
  const latest = await db.query.aiSuggestions.findFirst({
    where: and(
      eq(aiSuggestions.userId, userId),
      inArray(aiSuggestions.suggestionType, [...AUTO_SUGGESTION_TYPES])
    ),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
    columns: { createdAt: true },
  });

  const age = latest
    ? Date.now() - new Date(latest.createdAt).getTime()
    : Number.POSITIVE_INFINITY;

  // Skip the expensive delete/rebuild on every dashboard hit.
  if (age < SUGGESTION_REFRESH_TTL_MS) return;
  await refreshOutreachSuggestions(userId);
}

export async function getDashboardData(
  userId: string,
  options?: { userName?: string }
) {
  const db = await getDb();
  await maybeRefreshOutreachSuggestions(userId);

  const [allContactRows, pendingReminders, suggestions, goals, goalTexts] =
    await Promise.all([
      db.query.contacts.findMany({
        where: eq(contacts.userId, userId),
        orderBy: (c, { desc }) => [desc(c.updatedAt)],
        with: { contactTags: { with: { tag: true } } },
      }),
      db.query.reminders.findMany({
        where: and(
          eq(reminders.userId, userId),
          eq(reminders.status, "pending")
        ),
        orderBy: (r, { asc }) => [asc(r.dueDate)],
      }),
      db.query.aiSuggestions.findMany({
        where: and(
          eq(aiSuggestions.userId, userId),
          eq(aiSuggestions.status, "pending")
        ),
        orderBy: (s, { desc }) => [desc(s.confidenceScore)],
      }),
      db.query.userGoals.findMany({
        where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
        orderBy: (g, { desc }) => [desc(g.createdAt)],
      }),
      listActiveGoalTexts(userId),
    ]);

  const enrichedContacts = allContactRows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    return { ...c, tags };
  });

  const { metrics: networkMetrics, contactsWithNetwork } =
    computeNetworkMetrics(enrichedContacts, goalTexts);

  const closenessById = new Map(
    contactsWithNetwork.map((c) => [c.id, c])
  );

  const graphContacts = enrichedContacts.map((c) => {
    const closeness = closenessById.get(c.id);
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName ?? null,
      company: c.company ?? null,
      title: c.title ?? null,
      relationshipScore: c.relationshipScore ?? 2,
      closeness: closeness?.closeness ?? 0,
      closenessTier: closeness?.tier ?? "outer",
      orbitScore: closeness?.orbitScore ?? 2,
      lastInteractionAt: c.lastInteractionAt
        ? c.lastInteractionAt instanceof Date
          ? c.lastInteractionAt
          : new Date(c.lastInteractionAt)
        : null,
      nextFollowUpAt: c.nextFollowUpAt
        ? c.nextFollowUpAt instanceof Date
          ? c.nextFollowUpAt
          : new Date(c.nextFollowUpAt)
        : null,
      tags: c.tags ?? [],
      aiSummary: c.aiSummary ?? null,
      keyFacts: c.keyFacts ?? null,
      howMet: c.howMet ?? null,
      notes: c.notes ?? null,
      sharedInterests: c.sharedInterests ?? null,
    };
  });

  const userName = options?.userName || "You";

  const companies = [
    ...new Set(
      allContactRows.map((c) => c.company).filter(Boolean)
    ),
  ] as string[];

  const tags = [
    ...new Set(
      allContactRows.flatMap((c) =>
        c.contactTags.map((ct) => ct.tag.name)
      )
    ),
  ];

  const scoreCounts: Record<number, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };
  for (const c of graphContacts) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
  }

  const goalAlignedContacts = [...contactsWithNetwork]
    .filter((c) => c.goalRelevance > 0)
    .sort((a, b) => b.goalRelevance - a.goalRelevance)
    .slice(0, 5);

  const contactNameById = new Map(
    allContactRows.map((c) => [c.id, c.preferredName || c.fullName])
  );

  const now = new Date();
  const dueFollowUpIds = new Set(
    allContactRows
      .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
      .map((c) => c.id)
  );

  const tierRank = { inner: 0, mid: 1, outer: 2 } as const;

  const dueFollowUps = allContactRows
    .filter((c) => dueFollowUpIds.has(c.id))
    .sort((a, b) => {
      const aTime = a.nextFollowUpAt
        ? new Date(a.nextFollowUpAt).getTime()
        : 0;
      const bTime = b.nextFollowUpAt
        ? new Date(b.nextFollowUpAt).getTime()
        : 0;
      if (aTime !== bTime) return aTime - bTime;
      const aTier = closenessById.get(a.id)?.tier ?? "outer";
      const bTier = closenessById.get(b.id)?.tier ?? "outer";
      const tierDiff = tierRank[aTier] - tierRank[bTier];
      if (tierDiff !== 0) return tierDiff;
      return (b.priorityLevel || 0) - (a.priorityLevel || 0);
    });

  const filteredReminders = pendingReminders.filter((r) => {
    if (r.reminderType !== "generated") return true;
    if (!r.contactId) return true;
    return !dueFollowUpIds.has(r.contactId);
  });

  const contactById = new Map(allContactRows.map((c) => [c.id, c]));

  const filteredSuggestions = suggestions.filter((s) => {
    const contactId = s.relatedContactIds?.[0];
    if (!contactId) return true;
    return !dueFollowUpIds.has(contactId);
  });

  const strongTies =
    networkMetrics.tierCounts.inner + networkMetrics.tierCounts.mid;

  return {
    stats: {
      totalContacts: allContactRows.length,
      dueFollowUps: dueFollowUps.length,
      strongConnections: strongTies,
      pendingReminders: filteredReminders.length,
      topCompany: null as { name: string; count: number } | null,
    },
    recentContacts: allContactRows.slice(0, 6),
    dueFollowUps: dueFollowUps.slice(0, 12),
    reminders: filteredReminders.slice(0, 8),
    suggestions: filteredSuggestions.slice(0, 40),
    totalSuggestions: filteredSuggestions.length,
    goals,
    networkMetrics,
    goalAlignedContacts,
    closenessById,
    contactNameById,
    contactById,
    // Layout (nodes/edges) is computed client-side in NetworkGraph from contacts.
    graphPreview: {
      contacts: graphContacts,
      companies,
      tags,
      userId,
      summary: {
        total: allContactRows.length,
        companyCount: companies.length,
        scoreCounts,
        userName,
      },
    },
  };
}

export async function snoozeReminder(
  userId: string,
  reminderId: string,
  days = 7
) {
  const db = await getDb();
  const due = new Date();
  due.setDate(due.getDate() + days);

  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
    columns: { id: true, contactId: true },
  });
  if (!reminder) return;

  await db
    .update(reminders)
    .set({ dueDate: due, status: "pending" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));

  // Keep contact due clock aligned with reminder snooze.
  if (reminder.contactId) {
    await db
      .update(contacts)
      .set({
        nextFollowUpAt: due,
        followUpStatus: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId))
      );
  }
}

export async function completeReminder(userId: string, reminderId: string) {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "done" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));
}
