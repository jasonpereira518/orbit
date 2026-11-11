import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userProjects, type UserProject } from "@/db/schema";

export type { UserProject };

/**
 * Loads all active projects for a user, sorted by lastActivityAt desc.
 */
export async function listActiveProjectsForUser(
  userId: string,
  options: { limit?: number } = {}
): Promise<UserProject[]> {
  const db = await getDb();
  return db.query.userProjects.findMany({
    where: and(eq(userProjects.userId, userId), eq(userProjects.status, "active")),
    orderBy: [desc(userProjects.lastActivityAt)],
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

/**
 * Returns formatted text summaries of active projects for prompt steering and matching.
 */
export async function listActiveProjectSummariesForUser(
  userId: string,
  options: { limit?: number } = {}
): Promise<string[]> {
  const projects = await listActiveProjectsForUser(userId, options);
  return projects.map((p) => {
    const topicsStr = p.topics?.length ? ` [Topics: ${p.topics.join(", ")}]` : "";
    const summaryStr = p.summary ? ` - ${p.summary}` : "";
    return `${p.title}${summaryStr}${topicsStr}`;
  });
}

export type UpsertProjectInput = {
  title: string;
  summary?: string | null;
  topics: string[];
  status?: "active" | "dormant" | "completed";
  detectedFrom: "gmail" | "calendar" | "notes" | "manual";
  sourceRefs?: Array<{ type: string; id: string; snippet?: string }>;
  confidence?: number;
  lastActivityAt?: Date;
};

/**
 * Upserts a project: matches by title similarity or exact title (case-insensitive) for the user.
 * If found, updates the lastActivityAt, merges topics, updates summary, and updates confidence.
 * If not found, creates a new project.
 */
export async function upsertProjectForUser(
  userId: string,
  input: UpsertProjectInput
): Promise<UserProject> {
  const db = await getDb();
  const titleNorm = input.title.trim().toLowerCase();

  // Find candidate matches for this user
  const existing = await db.query.userProjects.findMany({
    where: eq(userProjects.userId, userId),
  });

  const matched = existing.find(
    (p) => p.title.trim().toLowerCase() === titleNorm || titleSimilarity(p.title, input.title) > 0.8
  );

  const now = new Date();
  const activityAt = input.lastActivityAt ?? now;

  if (matched) {
    // Merge topics
    const mergedTopics = Array.from(
      new Set([...(matched.topics || []), ...(input.topics || [])])
    ).slice(0, 15);

    const mergedRefs = [
      ...(matched.sourceRefs || []),
      ...(input.sourceRefs || []),
    ].slice(-10);

    const [updated] = await db
      .update(userProjects)
      .set({
        summary: input.summary ?? matched.summary,
        topics: mergedTopics,
        status: input.status ?? matched.status,
        sourceRefs: mergedRefs,
        confidence: Math.max(matched.confidence, input.confidence ?? 80),
        lastActivityAt: activityAt > matched.lastActivityAt ? activityAt : matched.lastActivityAt,
        updatedAt: now,
      })
      .where(and(eq(userProjects.id, matched.id), eq(userProjects.userId, userId)))
      .returning();

    return updated;
  }

  const [inserted] = await db
    .insert(userProjects)
    .values({
      userId,
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      topics: input.topics.slice(0, 15),
      status: input.status ?? "active",
      detectedFrom: input.detectedFrom,
      sourceRefs: input.sourceRefs ?? [],
      confidence: input.confidence ?? 80,
      lastActivityAt: activityAt,
    })
    .returning();

  return inserted;
}

/**
 * Quick token Jaccard similarity between two title strings.
 */
function titleSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Score overlap between a text block (e.g. contact bio, recent email, or news) and active user projects.
 */
export function scoreProjectMatch(
  projects: readonly UserProject[],
  text: string
): { bestProject: UserProject | null; score: number; matchedKeywords: string[] } {
  if (!projects.length || !text) {
    return { bestProject: null, score: 0, matchedKeywords: [] };
  }

  const norm = text.toLowerCase();
  let bestScore = 0;
  let bestProj: UserProject | null = null;
  let bestKeywords: string[] = [];

  for (const proj of projects) {
    let score = 0;
    const keywords: string[] = [];

    // Title word match
    const titleWords = proj.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const tw of titleWords) {
      if (norm.includes(tw)) {
        score += 8;
        keywords.push(tw);
      }
    }

    // Topics match
    for (const topic of proj.topics || []) {
      const topNorm = topic.toLowerCase().trim();
      if (topNorm.length > 2 && norm.includes(topNorm)) {
        score += 12;
        keywords.push(topic);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestProj = proj;
      bestKeywords = keywords;
    }
  }

  return {
    bestProject: bestProj,
    score: Math.min(bestScore, 30),
    matchedKeywords: bestKeywords,
  };
}
