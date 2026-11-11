/**
 * Upcoming Events Recommendation Engine.
 *
 * Analyzes the user's past event history (frequented cities, repeat organizers,
 * topic themes, target companies, and active career goals) to recommend high-fit
 * upcoming events with explainable match scores and rationale.
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { loadTargetKeys } from "@/lib/events/companies";
import { resolveThemeColor } from "@/lib/events/theme";

export type RecommendedEvent = {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt?: string | null;
  venue: string | null;
  city: string | null;
  attendanceMode: "offline" | "online" | "mixed";
  url: string;
  coverImageUrl?: string | null;
  themeColor: string;
  organizerName: string | null;
  platform: "luma" | "eventbrite" | "partiful" | "web";
  matchScore: number; // 0..100
  matchReasons: string[];
  topics: string[];
  alreadyAdded: boolean;
};

type UserEventHistoryProfile = {
  cities: Map<string, number>;
  organizers: Map<string, number>;
  topicKeywords: Map<string, number>;
  totalPastEvents: number;
  goals: string[];
  targetCompanies: Map<string, number>;
};

/** Common tech event topics and keywords for classification. */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  "AI & Machine Learning": [
    "ai",
    "artificial intelligence",
    "ml",
    "llm",
    "agents",
    "agentic",
    "deep learning",
    "neural",
    "genai",
    "generative ai",
    "tinkerers",
  ],
  "Founders & Startups": [
    "founder",
    "startups",
    "seed",
    "venture",
    "vc",
    "pitch",
    "demo day",
    "accelerator",
    "yc",
    "angel",
    "pre-seed",
    "fundraising",
  ],
  "Engineering & Architecture": [
    "dev",
    "engineering",
    "software",
    "infrastructure",
    "distributed",
    "cloud",
    "kubernetes",
    "rust",
    "typescript",
    "react",
    "next.js",
    "database",
    "postgres",
  ],
  "Design & Product": [
    "product",
    "design",
    "ux",
    "figma",
    "craft",
    "interface",
    "growth",
    "pm",
  ],
  "Networking & Mixers": [
    "mixer",
    "happy hour",
    "social",
    "drinks",
    "meetup",
    "gathering",
    "community",
    "salon",
  ],
};

/**
 * Real upcoming events to score. Empty until Radar's event search fills it
 * (docs/superpowers/specs/2026-11-10-radar-analyst-design.md, PR 8). It used to return six
 * invented events with made-up links, which the live Events tab showed as real.
 */
function getDiscoveryCatalog(): Array<Omit<RecommendedEvent, "matchScore" | "matchReasons" | "alreadyAdded">> {
  return [];
}

/**
 * Builds the user's historical event profile to ground recommendations.
 */
async function buildUserHistoryProfile(userId: string): Promise<UserEventHistoryProfile> {
  const db = await getDb();
  const pastEvents = await db
    .select({
      id: events.id,
      title: events.title,
      description: events.description,
      venue: events.venue,
      city: events.city,
      organizerName: events.organizerName,
      startsAt: events.startsAt,
    })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(desc(events.startsAt))
    .limit(100);

  const cities = new Map<string, number>();
  const organizers = new Map<string, number>();
  const topicKeywords = new Map<string, number>();

  for (const ev of pastEvents) {
    if (ev.city) {
      const c = ev.city.trim();
      cities.set(c, (cities.get(c) ?? 0) + 1);
    }
    if (ev.organizerName) {
      const org = ev.organizerName.trim();
      organizers.set(org, (organizers.get(org) ?? 0) + 1);
    }
    const textCorpus = `${ev.title} ${ev.description ?? ""}`.toLowerCase();
    for (const [category, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      for (const kw of keywords) {
        if (textCorpus.includes(kw)) {
          topicKeywords.set(category, (topicKeywords.get(category) ?? 0) + 1);
          break;
        }
      }
    }
  }

  const [goals, targets] = await Promise.all([
    listActiveGoalTextsForUser(userId).catch(() => []),
    loadTargetKeys(userId).catch(() => new Map<string, number>()),
  ]);

  return {
    cities,
    organizers,
    topicKeywords,
    totalPastEvents: pastEvents.length,
    goals,
    targetCompanies: targets,
  };
}

/**
 * Computes recommendation score and human-explainable match reasons.
 */
function scoreCandidateEvent(
  candidate: Omit<RecommendedEvent, "matchScore" | "matchReasons" | "alreadyAdded">,
  profile: UserEventHistoryProfile
): { score: number; reasons: string[] } {
  let score = 50; // base affinity
  const reasons: string[] = [];

  // 1. City / Location affinity (up to +25 points)
  if (candidate.attendanceMode === "online") {
    score += 15;
    reasons.push("Virtual / Online event open to anywhere");
  } else if (candidate.city && profile.cities.has(candidate.city)) {
    const visits = profile.cities.get(candidate.city)!;
    score += Math.min(visits * 8, 25);
    reasons.push(
      visits > 1
        ? `In ${candidate.city} (where you attended ${visits} past events)`
        : `In your active city: ${candidate.city}`
    );
  } else if (profile.cities.size === 0 && candidate.city === "San Francisco") {
    score += 10;
  }

  // 2. Organizer affinity (up to +25 points)
  if (candidate.organizerName && profile.organizers.has(candidate.organizerName)) {
    const orgCount = profile.organizers.get(candidate.organizerName)!;
    score += Math.min(orgCount * 12, 25);
    reasons.push(`Hosted by ${candidate.organizerName} (you attended their previous event)`);
  }

  // 3. Topic & Theme overlap (up to +25 points)
  let topicOverlapCount = 0;
  for (const topic of candidate.topics) {
    if (profile.topicKeywords.has(topic)) {
      topicOverlapCount += profile.topicKeywords.get(topic)!;
    }
  }
  if (topicOverlapCount > 0) {
    score += Math.min(topicOverlapCount * 6, 25);
    const topTopic = candidate.topics[0];
    reasons.push(`Matches your interest in ${topTopic}`);
  }

  // 4. Goal alignment (up to +15 points)
  if (profile.goals.length > 0) {
    const goalText = profile.goals.join(" ").toLowerCase();
    const isAiGoal = goalText.includes("ai") || goalText.includes("engineer");
    const isFounderGoal = goalText.includes("raise") || goalText.includes("startup") || goalText.includes("co-founder");

    if (isAiGoal && candidate.topics.includes("AI & Machine Learning")) {
      score += 12;
      reasons.push("Aligns with your AI & technical goals");
    } else if (isFounderGoal && candidate.topics.includes("Founders & Startups")) {
      score += 12;
      reasons.push("Aligns with your fundraising & startup goals");
    }
  }

  // Fallback reason if cold start
  if (reasons.length === 0) {
    reasons.push("Trending in the community with high founder attendance");
  }

  const finalScore = Math.min(Math.max(Math.round(score), 45), 98);
  return { score: finalScore, reasons: reasons.slice(0, 3) };
}

/**
 * Main query to retrieve personalized upcoming event recommendations.
 */
export async function getRecommendedUpcomingEvents(userId: string): Promise<RecommendedEvent[]> {
  const profile = await buildUserHistoryProfile(userId);
  const db = await getDb();

  // Load user's existing events to avoid recommending what they already have
  const existingEvents = await db
    .select({
      id: events.id,
      url: events.url,
      title: events.title,
    })
    .from(events)
    .where(eq(events.userId, userId));

  const existingUrls = new Set(existingEvents.map((e) => e.url).filter(Boolean));
  const existingTitles = new Set(existingEvents.map((e) => e.title.toLowerCase().trim()));

  const catalog = getDiscoveryCatalog();
  const scoredList: RecommendedEvent[] = [];

  for (const item of catalog) {
    const alreadyAdded =
      existingUrls.has(item.url) || existingTitles.has(item.title.toLowerCase().trim());

    const { score, reasons } = scoreCandidateEvent(item, profile);

    // Apply color resolution
    const theme = resolveThemeColor({
      metaColor: item.themeColor,
      seed: item.title,
    });

    scoredList.push({
      ...item,
      themeColor: theme.color,
      matchScore: score,
      matchReasons: reasons,
      alreadyAdded,
    });
  }

  // Sort by highest match score first, with un-added events prioritized
  return scoredList.sort((a, b) => {
    if (a.alreadyAdded !== b.alreadyAdded) {
      return a.alreadyAdded ? 1 : -1;
    }
    return b.matchScore - a.matchScore;
  });
}
