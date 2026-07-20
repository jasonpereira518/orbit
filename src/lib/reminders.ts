import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { aiSuggestions, contacts, interactions, reminders } from "@/db/schema";
import { daysAgo } from "@/lib/duplicates";

const AUTO_SUGGESTION_TYPES = [
  "overdue_follow_up",
  "dormant_high_value",
  "post_event",
  "linkedin_thread_quiet",
] as const;

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

  const suggestions: Array<{
    suggestionType: string;
    title: string;
    description: string;
    relatedContactIds: string[];
    confidenceScore: number;
  }> = [];

  const overdue = all.filter(
    (c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= new Date()
  );
  if (overdue.length) {
    suggestions.push({
      suggestionType: "overdue_follow_up",
      title: `${overdue.length} follow-up${overdue.length > 1 ? "s" : ""} overdue`,
      description: overdue
        .slice(0, 5)
        .map((c) => c.fullName)
        .join(", "),
      relatedContactIds: overdue.map((c) => c.id),
      confidenceScore: 90,
    });
  }

  const dormantHighValue = all.filter(
    (c) =>
      (c.priorityLevel >= 2 || c.relationshipScore >= 4) &&
      daysAgo(c.lastInteractionAt) >= 30
  );
  if (dormantHighValue.length) {
    suggestions.push({
      suggestionType: "dormant_high_value",
      title: `${dormantHighValue.length} strong connection${dormantHighValue.length > 1 ? "s" : ""} gone quiet`,
      description: "High-priority or close contacts with no recent interaction.",
      relatedContactIds: dormantHighValue.map((c) => c.id),
      confidenceScore: 80,
    });
  }

  // Active LinkedIn threads that went quiet (had message activity, then silence)
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

  const quietThreads = all.filter((c) => {
    const stats = messageStats.get(c.id);
    if (!stats || stats.count < 2) return false;
    const daysSinceLast = daysAgo(stats.last);
    // Had a real back-and-forth, last message 14–90 days ago
    return daysSinceLast >= 14 && daysSinceLast <= 90;
  });
  if (quietThreads.length) {
    suggestions.push({
      suggestionType: "linkedin_thread_quiet",
      title: `${quietThreads.length} LinkedIn thread${quietThreads.length > 1 ? "s" : ""} gone quiet`,
      description:
        "People you messaged with who haven't had activity in a couple weeks.",
      relatedContactIds: quietThreads.map((c) => c.id),
      confidenceScore: 78,
    });
  }

  const recentNoFollowUp = all.filter((c) => {
    if (!c.firstInteractionAt) return false;
    const days = daysAgo(c.firstInteractionAt);
    return (
      days >= 7 &&
      days <= 21 &&
      (!c.lastInteractionAt ||
        c.lastInteractionAt.getTime() === c.firstInteractionAt.getTime()) &&
      !c.nextFollowUpAt
    );
  });
  if (recentNoFollowUp.length) {
    suggestions.push({
      suggestionType: "post_event",
      title: `${recentNoFollowUp.length} recent intro${recentNoFollowUp.length > 1 ? "s" : ""} need a follow-up`,
      description: "People you met recently without a logged follow-up.",
      relatedContactIds: recentNoFollowUp.map((c) => c.id),
      confidenceScore: 75,
    });
  }

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

export async function getDashboardData(userId: string) {
  const db = await getDb();
  await maybeRefreshOutreachSuggestions(userId);

  const [allContacts, pendingReminders, suggestions] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      orderBy: (c, { desc }) => [desc(c.updatedAt)],
    }),
    db.query.reminders.findMany({
      where: and(eq(reminders.userId, userId), eq(reminders.status, "pending")),
      orderBy: (r, { asc }) => [asc(r.dueDate)],
    }),
    db.query.aiSuggestions.findMany({
      where: and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending")
      ),
      orderBy: (s, { desc }) => [desc(s.confidenceScore)],
    }),
  ]);

  const now = new Date();
  const dueFollowUps = allContacts
    .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
    .sort((a, b) => {
      const aTime = a.nextFollowUpAt
        ? new Date(a.nextFollowUpAt).getTime()
        : 0;
      const bTime = b.nextFollowUpAt
        ? new Date(b.nextFollowUpAt).getTime()
        : 0;
      return aTime - bTime;
    });

  const strongAi = allContacts.filter((c) => (c.relationshipScore || 0) >= 4);
  const companies = new Map<string, number>();
  for (const c of allContacts) {
    if (c.company) companies.set(c.company, (companies.get(c.company) || 0) + 1);
  }
  const topCompany = [...companies.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    stats: {
      totalContacts: allContacts.length,
      dueFollowUps: dueFollowUps.length,
      strongConnections: strongAi.length,
      pendingReminders: pendingReminders.length,
      topCompany: topCompany ? { name: topCompany[0], count: topCompany[1] } : null,
    },
    recentContacts: allContacts.slice(0, 6),
    dueFollowUps: dueFollowUps.slice(0, 12),
    reminders: pendingReminders.slice(0, 8),
    suggestions,
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
  await db
    .update(reminders)
    .set({ dueDate: due, status: "pending" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));
}

export async function completeReminder(userId: string, reminderId: string) {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "done" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));
}
