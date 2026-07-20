import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  companies,
  contacts,
  interactions,
  userGoals,
} from "@/db/schema";
import { computeCloseness } from "@/lib/closeness";
import { daysAgo } from "@/lib/duplicates";

export type NetworkStatItem = {
  label: string;
  value: number;
  suffix?: string;
  detail?: string;
  /** When true, show an em dash instead of animating zero (e.g. no network age yet). */
  empty?: boolean;
};

export type NetworkStats = {
  headline: string;
  subheadline: string;
  items: NetworkStatItem[];
};

function fmt(n: number) {
  return n.toLocaleString();
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

  const [allContacts, allInteractions, allCompanies, allGoals] =
    await Promise.all([
      db.query.contacts.findMany({
        where: eq(contacts.userId, userId),
        with: { contactTags: { with: { tag: true } } },
      }),
      db.query.interactions.findMany({
        where: eq(interactions.userId, userId),
        columns: { id: true },
      }),
      db.query.companies.findMany({
        where: eq(companies.userId, userId),
        columns: { id: true },
      }),
      db.query.userGoals.findMany({ where: eq(userGoals.userId, userId) }),
    ]);

  const now = new Date();
  const activeGoals = allGoals.filter((g) => g.active).map((g) => g.text);

  let innerCircle = 0;
  let closenessSum = 0;
  let dormant30 = 0;
  let overdueFollowUps = 0;
  let oldestContactAt: Date | null = null;

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

    if (c.lastInteractionAt && daysAgo(c.lastInteractionAt) >= 30) {
      dormant30++;
    }

    if (c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now) {
      overdueFollowUps++;
    }

    const created = new Date(c.createdAt);
    if (!oldestContactAt || created < oldestContactAt) oldestContactAt = created;
  }

  const networkAgeDays = oldestContactAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - oldestContactAt.getTime()) / 86400000)
      )
    : 0;

  const avgCloseness =
    allContacts.length > 0
      ? Math.round((closenessSum / allContacts.length) * 100)
      : 0;

  const { headline, subheadline } = pickHeadline({
    contacts: allContacts.length,
    innerCircle,
    interactions: allInteractions.length,
    overdue: overdueFollowUps,
    networkAgeDays,
  });

  return {
    headline,
    subheadline,
    items: [
      {
        label: "Interactions logged",
        value: allInteractions.length,
      },
      {
        label: "Inner orbit",
        value: innerCircle,
        detail: "Closest ties",
      },
      {
        label: "Dormant (30+ days)",
        value: dormant30,
      },
      {
        label: "Avg closeness",
        value: avgCloseness,
        suffix: "%",
      },
      {
        label: "Companies tracked",
        value: allCompanies.length,
      },
      {
        label: "Network age",
        value: networkAgeDays,
        suffix: networkAgeDays > 0 ? " days" : undefined,
        empty: networkAgeDays === 0,
        detail: oldestContactAt
          ? `Since ${oldestContactAt.toLocaleDateString()}`
          : undefined,
      },
    ],
  };
}
