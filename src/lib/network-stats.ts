import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { companies, interactions } from "@/db/schema";
import { closenessTier } from "@/lib/closeness";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { getNetworkStatsCounts } from "@/lib/dashboard-aggregates";

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

export async function getNetworkStats(
  userId: string,
  preloaded?: {
    interactionCount?: number;
    companyCount?: number;
  }
): Promise<NetworkStats> {
  const db = await getDb();

  const [
    aggregates,
    interactionCountRows,
    companyCountRows,
    closenessCohort,
  ] = await Promise.all([
    // Four integers from one statement, where this used to loop every contact in the
    // account. The dashboard donated its scan for that loop, which is why two of the widest
    // columns on the contacts row had to be selected for everyone. See getNetworkStatsCounts.
    getNetworkStatsCounts(userId),
    preloaded?.interactionCount != null
      ? Promise.resolve([{ value: preloaded.interactionCount }])
      : db
          .select({ value: count() })
          .from(interactions)
          .where(eq(interactions.userId, userId)),
    preloaded?.companyCount != null
      ? Promise.resolve([{ value: preloaded.companyCount }])
      : db
          .select({ value: count() })
          .from(companies)
          .where(eq(companies.userId, userId)),
    getClosenessCohort(userId),
  ]);

  const interactionCount = interactionCountRows[0]?.value ?? 0;
  const companyCount = companyCountRows[0]?.value ?? 0;

  const now = new Date();
  // The one figure that is not a column predicate: inner circle is counted by ABSOLUTE
  // score rather than the displayed tier, because inner/mid/outer are quota shares — a
  // fixed fraction of the network would be reported as "closest ties" however cold
  // everything got. The cohort is already loaded above, so this costs nothing.
  let innerCircle = 0;
  for (const breakdown of closenessCohort.byId.values()) {
    if (closenessTier(breakdown.raw) === "inner") innerCircle++;
  }

  const dormant30 = aggregates.dormant30;
  const overdueFollowUps = aggregates.overdueFollowUps;
  const oldestContactAt = aggregates.oldestContactAt;

  const networkAgeDays = oldestContactAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - oldestContactAt.getTime()) / 86400000)
      )
    : 0;

  // Deliberately the mean of the *absolute* scores. The blended score is half
  // percentile, whose mean is 0.5 by construction, so averaging that would park
  // this stat near 50% and stop it reacting to the network going cold.
  const avgCloseness = Math.round(closenessCohort.averageRaw * 100);

  const { headline, subheadline } = pickHeadline({
    contacts: aggregates.totalContacts,
    innerCircle,
    interactions: interactionCount,
    overdue: overdueFollowUps,
    networkAgeDays,
  });

  return {
    headline,
    subheadline,
    items: [
      {
        label: "Interactions logged",
        value: interactionCount,
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
        value: companyCount,
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
