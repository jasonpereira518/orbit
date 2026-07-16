import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiSuggestions, contacts, reminders } from "@/db/schema";
import { daysAgo } from "@/lib/duplicates";

export async function refreshOutreachSuggestions(userId: string) {
  const db = await getDb();
  const all = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  // Clear pending auto suggestions so we regenerate fresh ones
  await db
    .delete(aiSuggestions)
    .where(
      and(eq(aiSuggestions.userId, userId), eq(aiSuggestions.status, "pending"))
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

export async function getDashboardData(userId: string) {
  const db = await getDb();
  await refreshOutreachSuggestions(userId);

  const allContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    orderBy: (c, { desc }) => [desc(c.updatedAt)],
  });

  const pendingReminders = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, userId), eq(reminders.status, "pending")),
    orderBy: (r, { asc }) => [asc(r.dueDate)],
  });

  const suggestions = await db.query.aiSuggestions.findMany({
    where: and(
      eq(aiSuggestions.userId, userId),
      eq(aiSuggestions.status, "pending")
    ),
    orderBy: (s, { desc }) => [desc(s.confidenceScore)],
  });

  const now = new Date();
  const dueFollowUps = allContacts.filter(
    (c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now
  );

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
    dueFollowUps: dueFollowUps.slice(0, 8),
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
