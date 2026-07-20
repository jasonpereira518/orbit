import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  calendarSubscriptions,
  companies,
  contactEmbeddings,
  contacts,
  imports,
  interactions,
  outreachCampaigns,
  reminders,
  tags,
  userGoals,
  userSettings,
} from "@/db/schema";
import { computeCloseness } from "@/lib/closeness";
import { daysAgo } from "@/lib/duplicates";
import { metContextLabel } from "@/lib/met-context";

export type NetworkStatItem = {
  label: string;
  value: string;
  detail?: string;
  fun?: boolean;
};

export type NetworkStatsSection = {
  title: string;
  subtitle?: string;
  items: NetworkStatItem[];
};

export type NetworkStats = {
  headline: string;
  subheadline: string;
  sections: NetworkStatsSection[];
};

function fmt(n: number) {
  return n.toLocaleString();
}

function pct(n: number, total: number) {
  if (total <= 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

function topEntry(counts: Map<string, number>) {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0] ?? null;
}

function wordCount(text: string | null | undefined) {
  if (!text?.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

function pickHeadline(input: {
  contacts: number;
  innerCircle: number;
  interactions: number;
  overdue: number;
  networkAgeDays: number;
}): { headline: string; subheadline: string } {
  if (input.contacts === 0) {
    return {
      headline: "Empty orbit",
      subheadline: "Add someone and the numbers will start stacking up.",
    };
  }
  if (input.innerCircle >= 15) {
    return {
      headline: "Gravity well detected",
      subheadline: `${input.innerCircle} people in your inner orbit. You're the sun.`,
    };
  }
  if (input.contacts >= 200) {
    return {
      headline: "Human CRM unlocked",
      subheadline: `${fmt(input.contacts)} contacts and counting. LinkedIn is nervous.`,
    };
  }
  if (input.interactions >= 500) {
    return {
      headline: "Interaction machine",
      subheadline: "Your conversation log could fill a novella.",
    };
  }
  if (input.overdue >= 10) {
    return {
      headline: "Follow-up mountain",
      subheadline: `${input.overdue} people are patiently waiting for your ping.`,
    };
  }
  if (input.networkAgeDays >= 365) {
    return {
      headline: "One year in orbit",
      subheadline: "You've been curating this network for a while.",
    };
  }
  return {
    headline: "Network by the numbers",
    subheadline: "Everything Orbit knows about your constellation.",
  };
}

export async function getNetworkStats(userId: string): Promise<NetworkStats> {
  const db = await getDb();

  const [
    allContacts,
    allInteractions,
    allReminders,
    allTags,
    allCompanies,
    allImports,
    allEmbeddings,
    allGoals,
    allCalendars,
    pendingSuggestions,
    settingsRow,
    outreachCampaignRows,
  ] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      with: { contactTags: { with: { tag: true } } },
    }),
    db.query.interactions.findMany({
      where: eq(interactions.userId, userId),
      columns: {
        id: true,
        interactionType: true,
        interactionDate: true,
        rawNotes: true,
      },
    }),
    db.query.reminders.findMany({
      where: eq(reminders.userId, userId),
      columns: { id: true, status: true, dueDate: true },
    }),
    db.query.tags.findMany({ where: eq(tags.userId, userId) }),
    db.query.companies.findMany({
      where: eq(companies.userId, userId),
      columns: { id: true, name: true },
    }),
    db.query.imports.findMany({ where: eq(imports.userId, userId) }),
    db.query.contactEmbeddings.findMany({
      where: eq(contactEmbeddings.userId, userId),
      columns: { id: true, embedding: true },
    }),
    db.query.userGoals.findMany({ where: eq(userGoals.userId, userId) }),
    db.query.calendarSubscriptions.findMany({
      where: eq(calendarSubscriptions.userId, userId),
    }),
    db.query.aiSuggestions.findMany({
      where: and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending")
      ),
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { createdAt: true, onboardingCompletedAt: true },
    }),
    db.query.outreachCampaigns.findMany({
      where: eq(outreachCampaigns.userId, userId),
      columns: { id: true, status: true },
    }),
  ]);

  const taggedLinks = allContacts.reduce(
    (sum, c) => sum + c.contactTags.length,
    0
  );

  let outreachProspectCount = 0;
  let outreachMessageCount = 0;
  let outreachSentCount = 0;
  if (outreachCampaignRows.length > 0) {
    const campaignIds = outreachCampaignRows.map((c) => c.id);
    const prospects = await db.query.outreachProspects.findMany({
      where: (t, { inArray }) => inArray(t.campaignId, campaignIds),
      columns: { id: true },
    });
    outreachProspectCount = prospects.length;
    if (prospects.length > 0) {
      const prospectIds = prospects.map((p) => p.id);
      const messages = await db.query.outreachMessages.findMany({
        where: (t, { inArray }) => inArray(t.prospectId, prospectIds),
        columns: { id: true, status: true },
      });
      outreachMessageCount = messages.length;
      outreachSentCount = messages.filter((m) => m.status === "sent").length;
    }
  }

  const now = new Date();
  const activeGoals = allGoals.filter((g) => g.active).map((g) => g.text);

  let innerCircle = 0;
  let midOrbit = 0;
  let outerOrbit = 0;
  let closenessSum = 0;
  let strongTies = 0;
  let priorityVips = 0;
  let withEmail = 0;
  let withLinkedIn = 0;
  let withPhone = 0;
  let withAiSummary = 0;
  let withNotes = 0;
  let neverContacted = 0;
  let dormant30 = 0;
  let dormant90 = 0;
  let overdueFollowUps = 0;
  let keyFactsTotal = 0;
  let opportunitiesTotal = 0;
  let sharedInterestsTotal = 0;
  let noteWords = 0;
  let longestNoteWords = 0;
  let introCount = 0;
  let eventCount = 0;
  let onlineCount = 0;
  let recentAdds30 = 0;

  const companyCounts = new Map<string, number>();
  const locationCounts = new Map<string, number>();
  const industryCounts = new Map<string, number>();
  const metContextCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  let oldestContactAt: Date | null = null;
  let latestInteractionAt: Date | null = null;

  for (const c of allContacts) {
    const breakdown = computeCloseness(
      {
        relationshipScore: c.relationshipScore,
        lastInteractionAt: c.lastInteractionAt,
        createdAt: c.createdAt,
        company: c.company,
        title: c.title,
        industry: c.industry,
        howMet: c.howMet,
        notes: c.notes,
        aiSummary: c.aiSummary,
        keyFacts: c.keyFacts,
        sharedInterests: c.sharedInterests,
        tags: c.contactTags.map((ct) => ct.tag.name),
      },
      activeGoals
    );

    closenessSum += breakdown.closeness;
    if (breakdown.tier === "inner") innerCircle++;
    else if (breakdown.tier === "mid") midOrbit++;
    else outerOrbit++;

    if ((c.relationshipScore || 0) >= 4) strongTies++;
    if ((c.priorityLevel || 0) >= 2) priorityVips++;
    if (c.email) withEmail++;
    if (c.linkedinUrl) withLinkedIn++;
    if (c.phone) withPhone++;
    if (c.aiSummary?.trim()) withAiSummary++;
    if (c.notes?.trim()) withNotes++;

    if (!c.lastInteractionAt) neverContacted++;
    else {
      const days = daysAgo(c.lastInteractionAt);
      if (days >= 30) dormant30++;
      if (days >= 90) dormant90++;
      const d = new Date(c.lastInteractionAt);
      if (!latestInteractionAt || d > latestInteractionAt) {
        latestInteractionAt = d;
      }
    }

    if (c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now) {
      overdueFollowUps++;
    }

    keyFactsTotal += c.keyFacts?.length ?? 0;
    opportunitiesTotal += c.opportunities?.length ?? 0;
    sharedInterestsTotal += c.sharedInterests?.length ?? 0;

    const words = wordCount(c.notes);
    noteWords += words;
    if (words > longestNoteWords) longestNoteWords = words;

    if (c.metContext === "introduction") introCount++;
    if (c.metContext === "event") eventCount++;
    if (c.metContext === "online") onlineCount++;

    if (c.company) {
      companyCounts.set(c.company, (companyCounts.get(c.company) || 0) + 1);
    }
    if (c.location?.trim()) {
      const loc = c.location.trim();
      locationCounts.set(loc, (locationCounts.get(loc) || 0) + 1);
    }
    if (c.industry?.trim()) {
      const ind = c.industry.trim();
      industryCounts.set(ind, (industryCounts.get(ind) || 0) + 1);
    }
    if (c.metContext) {
      const label = metContextLabel(c.metContext) || c.metContext;
      metContextCounts.set(label, (metContextCounts.get(label) || 0) + 1);
    }

    for (const ct of c.contactTags) {
      tagCounts.set(
        ct.tag.name,
        (tagCounts.get(ct.tag.name) || 0) + 1
      );
    }

    const created = new Date(c.createdAt);
    if (!oldestContactAt || created < oldestContactAt) oldestContactAt = created;
    if (daysAgo(c.createdAt) <= 30) recentAdds30++;
  }

  const interactionTypeCounts = new Map<string, number>();
  let interactionNoteWords = 0;
  const monthCounts = new Map<string, number>();

  for (const i of allInteractions) {
    interactionTypeCounts.set(
      i.interactionType,
      (interactionTypeCounts.get(i.interactionType) || 0) + 1
    );
    interactionNoteWords += wordCount(i.rawNotes);
    const d = new Date(i.interactionDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
    if (!latestInteractionAt || d > latestInteractionAt) latestInteractionAt = d;
  }

  const pendingReminders = allReminders.filter((r) => r.status === "pending");
  const doneReminders = allReminders.filter((r) => r.status === "done");

  let importContactsCreated = 0;
  let importContactsUpdated = 0;
  let importRowsProcessed = 0;
  let messagesImported = 0;
  let meetingsLogged = 0;

  for (const imp of allImports) {
    importContactsCreated += imp.contactsCreated ?? 0;
    importContactsUpdated += imp.contactsUpdated ?? 0;
    importRowsProcessed += imp.rowsProcessed ?? 0;
    messagesImported += imp.stats?.messagesImported ?? 0;
    meetingsLogged += imp.stats?.meetingsLogged ?? 0;
  }

  const topCompany = topEntry(companyCounts);
  const topLocation = topEntry(locationCounts);
  const topIndustry = topEntry(industryCounts);
  const topMetContext = topEntry(metContextCounts);
  const topTag = topEntry(tagCounts);
  const topInteractionType = topEntry(interactionTypeCounts);
  const busiestMonth = topEntry(monthCounts);

  const networkAgeDays = oldestContactAt
    ? Math.max(0, Math.floor((now.getTime() - oldestContactAt.getTime()) / 86400000))
    : 0;

  const daysSinceLastTouch = latestInteractionAt
    ? daysAgo(latestInteractionAt)
    : null;

  const avgCloseness =
    allContacts.length > 0
      ? Math.round((closenessSum / allContacts.length) * 100)
      : 0;

  const avgRelationship =
    allContacts.length > 0
      ? (
          allContacts.reduce((s, c) => s + (c.relationshipScore || 2), 0) /
          allContacts.length
        ).toFixed(1)
      : "0";

  const embeddingDimensions = allEmbeddings.reduce(
    (s, e) => s + (e.embedding?.length ?? 0),
    0
  );

  const { headline, subheadline } = pickHeadline({
    contacts: allContacts.length,
    innerCircle,
    interactions: allInteractions.length,
    overdue: overdueFollowUps,
    networkAgeDays,
  });

  const overview: NetworkStatItem[] = [
    { label: "People in orbit", value: fmt(allContacts.length) },
    { label: "Interactions logged", value: fmt(allInteractions.length) },
    { label: "Companies tracked", value: fmt(allCompanies.length) },
    { label: "Tags applied", value: fmt(taggedLinks) },
    { label: "Unique tags", value: fmt(allTags.length) },
    {
      label: "Network age",
      value: networkAgeDays > 0 ? `${fmt(networkAgeDays)} days` : "—",
      detail: oldestContactAt
        ? `Since ${oldestContactAt.toLocaleDateString()}`
        : undefined,
    },
  ];

  const relationship: NetworkStatItem[] = [
    { label: "Inner orbit", value: fmt(innerCircle), detail: "Closest ties" },
    { label: "Mid orbit", value: fmt(midOrbit) },
    { label: "Outer orbit", value: fmt(outerOrbit) },
    { label: "Strong ties (4–5)", value: fmt(strongTies) },
    { label: "Priority VIPs", value: fmt(priorityVips) },
    {
      label: "Avg closeness",
      value: `${avgCloseness}%`,
      detail: `Avg strength ${avgRelationship}/5`,
    },
    { label: "Due follow-ups", value: fmt(overdueFollowUps) },
    { label: "Pending reminders", value: fmt(pendingReminders.length) },
    { label: "Reminders completed", value: fmt(doneReminders.length) },
    { label: "Dormant (30+ days)", value: fmt(dormant30) },
    { label: "Gone quiet (90+ days)", value: fmt(dormant90) },
    {
      label: "Never contacted",
      value: fmt(neverContacted),
      fun: neverContacted > 0,
      detail: "Added but no interaction yet",
    },
  ];

  const coverage: NetworkStatItem[] = [
    {
      label: "With email",
      value: fmt(withEmail),
      detail: pct(withEmail, allContacts.length),
    },
    {
      label: "With LinkedIn",
      value: fmt(withLinkedIn),
      detail: pct(withLinkedIn, allContacts.length),
    },
    {
      label: "With phone",
      value: fmt(withPhone),
      detail: pct(withPhone, allContacts.length),
    },
    {
      label: "AI summaries",
      value: fmt(withAiSummary),
      detail: pct(withAiSummary, allContacts.length),
    },
    {
      label: "With notes",
      value: fmt(withNotes),
      detail: pct(withNotes, allContacts.length),
    },
    {
      label: "Embeddings stored",
      value: fmt(allEmbeddings.length),
      detail: "For semantic search",
    },
    {
      label: "Active goals",
      value: fmt(activeGoals.length),
      detail: activeGoals.length ? activeGoals.slice(0, 2).join(", ") : undefined,
    },
    { label: "Pending AI suggestions", value: fmt(pendingSuggestions.length) },
  ];

  const activity: NetworkStatItem[] = [
    {
      label: "Added last 30 days",
      value: fmt(recentAdds30),
    },
    {
      label: "Last touch",
      value:
        daysSinceLastTouch === null
          ? "—"
          : daysSinceLastTouch === 0
            ? "Today"
            : `${fmt(daysSinceLastTouch)} days ago`,
    },
    {
      label: "Top interaction type",
      value: topInteractionType?.[0] ?? "—",
      detail: topInteractionType
        ? `${fmt(topInteractionType[1])} logged`
        : undefined,
    },
    {
      label: "Busiest month",
      value: busiestMonth?.[0] ?? "—",
      detail: busiestMonth ? `${fmt(busiestMonth[1])} interactions` : undefined,
    },
    { label: "Imports run", value: fmt(allImports.length) },
    { label: "Import rows processed", value: fmt(importRowsProcessed) },
    { label: "Contacts from imports", value: fmt(importContactsCreated) },
    { label: "LinkedIn messages imported", value: fmt(messagesImported) },
    { label: "Meetings from calendar", value: fmt(meetingsLogged) },
    { label: "Calendar subscriptions", value: fmt(allCalendars.length) },
    { label: "Outreach campaigns", value: fmt(outreachCampaignRows.length) },
    { label: "Outreach prospects", value: fmt(outreachProspectCount) },
    { label: "Outreach messages", value: fmt(outreachMessageCount) },
    { label: "Outreach messages sent", value: fmt(outreachSentCount) },
  ];

  const funFacts: NetworkStatItem[] = [
    {
      label: "Words in contact notes",
      value: fmt(noteWords),
      fun: true,
      detail: longestNoteWords > 0 ? `Longest note: ${fmt(longestNoteWords)} words` : undefined,
    },
    {
      label: "Words in interaction logs",
      value: fmt(interactionNoteWords),
      fun: true,
    },
    {
      label: "Key facts collected",
      value: fmt(keyFactsTotal),
      fun: true,
    },
    {
      label: "Opportunities spotted",
      value: fmt(opportunitiesTotal),
      fun: true,
    },
    {
      label: "Shared interests noted",
      value: fmt(sharedInterestsTotal),
      fun: true,
    },
    {
      label: "Intro magnet",
      value: fmt(introCount),
      fun: true,
      detail: "Met via introduction",
    },
    {
      label: "Event networkers",
      value: fmt(eventCount),
      fun: true,
      detail: "Met at events",
    },
    {
      label: "Online connections",
      value: fmt(onlineCount),
      fun: true,
    },
    {
      label: "Embedding neurons",
      value: fmt(embeddingDimensions),
      fun: true,
      detail: "Total vector dimensions stored",
    },
    {
      label: "Coffee debt",
      value: fmt(overdueFollowUps),
      fun: true,
      detail: "Overdue follow-ups owed",
    },
    {
      label: "LinkedIn hoard",
      value: fmt(withLinkedIn),
      fun: true,
      detail: "Profiles collected",
    },
    {
      label: "Follow-up karma",
      value: fmt(doneReminders.length),
      fun: true,
      detail: "Reminders you've cleared",
    },
  ];

  const highlights: NetworkStatItem[] = [
    {
      label: "Top company",
      value: topCompany?.[0] ?? "—",
      detail: topCompany ? `${fmt(topCompany[1])} people` : undefined,
    },
    {
      label: "Top location",
      value: topLocation?.[0] ?? "—",
      detail: topLocation ? `${fmt(topLocation[1])} people` : undefined,
    },
    {
      label: "Top industry",
      value: topIndustry?.[0] ?? "—",
      detail: topIndustry ? `${fmt(topIndustry[1])} people` : undefined,
    },
    {
      label: "Most common “how we met”",
      value: topMetContext?.[0] ?? "—",
      detail: topMetContext ? `${fmt(topMetContext[1])} people` : undefined,
    },
    {
      label: "Most used tag",
      value: topTag?.[0] ?? "—",
      detail: topTag ? `${fmt(topTag[1])} contacts` : undefined,
    },
    {
      label: "Unique locations",
      value: fmt(locationCounts.size),
    },
    {
      label: "Unique industries",
      value: fmt(industryCounts.size),
    },
  ];

  if (settingsRow?.onboardingCompletedAt) {
    funFacts.push({
      label: "Tutorial graduate",
      value: "✓",
      fun: true,
      detail: new Date(settingsRow.onboardingCompletedAt).toLocaleDateString(),
    });
  }

  return {
    headline,
    subheadline,
    sections: [
      { title: "Overview", items: overview },
      { title: "Relationship health", subtitle: "Orbits, strength, and follow-ups", items: relationship },
      { title: "Coverage", subtitle: "What you've captured per person", items: coverage },
      { title: "Activity & imports", items: activity },
      { title: "Highlights", subtitle: "Top entries in your network", items: highlights },
      { title: "Fun facts", subtitle: "The quirky stuff", items: funFacts },
    ],
  };
}
