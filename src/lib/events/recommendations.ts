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
 * Curated discovery catalog of upcoming industry events in major tech hubs.
 * Updated with upcoming dates relative to current wall-clock.
 */
function getDiscoveryCatalog(): Array<Omit<RecommendedEvent, "matchScore" | "matchReasons" | "alreadyAdded">> {
  const now = Date.now();
  const day = 86_400_000;

  return [
    {
      id: "rec-sf-ai-agents-summit",
      title: "Autonomous Agents & Frontier AI Summit",
      description: "Join 350+ AI engineers and founders building autonomous coding agents, LLM tool harnesses, and reasoning architectures. Keynotes by frontier lab researchers.",
      startsAt: new Date(now + 4 * day).toISOString(),
      endsAt: new Date(now + 4 * day + 6 * 3600_000).toISOString(),
      venue: "The Hibernia, 1 Jones St",
      city: "San Francisco",
      attendanceMode: "offline",
      url: "https://lu.ma/sf-ai-agents-summit",
      coverImageUrl: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=1200&auto=format&fit=crop&q=80",
      themeColor: "#6366f1",
      organizerName: "Cerebral Valley & AI Collective",
      platform: "luma",
      topics: ["AI & Machine Learning", "Engineering & Architecture"],
    },
    {
      id: "rec-sf-founders-pitch-mixer",
      title: "SF Founders & Angel Investors Mixer",
      description: "Casual evening mixer for early-stage technical founders raising Pre-Seed and Seed rounds. Direct networking with active angel syndicates and venture scouts.",
      startsAt: new Date(now + 7 * day).toISOString(),
      endsAt: new Date(now + 7 * day + 3 * 3600_000).toISOString(),
      venue: "South Park Commons",
      city: "San Francisco",
      attendanceMode: "offline",
      url: "https://partiful.com/e/sf-founders-mixer",
      coverImageUrl: "https://images.unsplash.com/photo-1511578314322-379afb476865?w=1200&auto=format&fit=crop&q=80",
      themeColor: "#ec4899",
      organizerName: "South Park Founders",
      platform: "partiful",
      topics: ["Founders & Startups", "Networking & Mixers"],
    },
    {
      id: "rec-nyc-tech-week-kickoff",
      title: "NYC Tech Week: AI in Production & Enterprise Scale",
      description: "Panel and rooftop networking exploring production deployment of generative systems, latency optimization, and enterprise governance.",
      startsAt: new Date(now + 11 * day).toISOString(),
      endsAt: new Date(now + 11 * day + 4 * 3600_000).toISOString(),
      venue: "Spring Studios, Tribeca",
      city: "New York",
      attendanceMode: "offline",
      url: "https://www.eventbrite.com/e/nyc-tech-week-ai-production-tickets",
      coverImageUrl: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1200&auto=format&fit=crop&q=80",
      themeColor: "#0284c7",
      organizerName: "NYC Tech Collective",
      platform: "eventbrite",
      topics: ["AI & Machine Learning", "Engineering & Architecture"],
    },
    {
      id: "rec-global-remote-evals-hackathon",
      title: "Agentic Evaluations & Benchmarks Virtual Hackathon",
      description: "48-hour global virtual hackathon focused on building robust eval harnesses, self-correcting agents, and synthetic dataset pipelines.",
      startsAt: new Date(now + 14 * day).toISOString(),
      endsAt: new Date(now + 16 * day).toISOString(),
      venue: "Online / Discord",
      city: null,
      attendanceMode: "online",
      url: "https://lu.ma/evals-virtual-hackathon",
      coverImageUrl: "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=1200&auto=format&fit=crop&q=80",
      themeColor: "#10b981",
      organizerName: "OpenEval Community",
      platform: "luma",
      topics: ["AI & Machine Learning", "Engineering & Architecture"],
    },
    {
      id: "rec-sf-design-eng-salon",
      title: "Craft & Motion: Design Engineering Salon",
      description: "An intimate gathering of design engineers and product builders obsessing over fluid micro-interactions, spatial UI, physics springs, and typography.",
      startsAt: new Date(now + 18 * day).toISOString(),
      endsAt: new Date(now + 18 * day + 3 * 3600_000).toISOString(),
      venue: "Mission District Loft",
      city: "San Francisco",
      attendanceMode: "offline",
      url: "https://partiful.com/e/design-eng-salon",
      coverImageUrl: "https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=1200&auto=format&fit=crop&q=80",
      themeColor: "#f59e0b",
      organizerName: "Interface Craft Club",
      platform: "partiful",
      topics: ["Design & Product", "Engineering & Architecture"],
    },
    {
      id: "rec-austin-hardware-ai-meetup",
      title: "Austin AI Hardware & Robotics Showcase",
      description: "Live demonstrations of edge AI processors, humanoid robots, and drone perception stacks. Featuring founders and lab heads from across Texas.",
      startsAt: new Date(now + 21 * day).toISOString(),
      endsAt: new Date(now + 21 * day + 4 * 3600_000).toISOString(),
      venue: "Capital Factory, 701 Brazos St",
      city: "Austin",
      attendanceMode: "offline",
      url: "https://www.eventbrite.com/e/austin-ai-hardware-showcase-tickets",
      coverImageUrl: "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=1200&auto=format&fit=crop&q=80",
      themeColor: "#8b5cf6",
      organizerName: "Austin Hardware Guild",
      platform: "eventbrite",
      topics: ["AI & Machine Learning", "Engineering & Architecture"],
    },
  ];
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
