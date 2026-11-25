/**
 * Project and Experience Scorer
 *
 * Scores candidate alignment with user's active projects (user_projects) and career goals (user_goals).
 * Range: 0 to 30 points.
 */

import type { RawCandidate, UserDiscoveryContext, MatchedProject } from "../types";

export type ProjectScoreResult = {
  score: number;
  matchedProjects: MatchedProject[];
  reasons: string[];
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he",
  "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were", "will", "with"
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export function scoreProjectAffinity(
  candidate: RawCandidate,
  context: UserDiscoveryContext,
  targetProjectId?: string
): ProjectScoreResult {
  const matchedProjects: MatchedProject[] = [];
  const reasons: string[] = [];
  let score = 0;

  // Build candidate text pool
  const candidatePoolParts = [
    candidate.headline || "",
    candidate.title || "",
    candidate.bio || "",
    ...(candidate.topics || []),
    ...(candidate.experienceHistory || []).map((e) => `${e.title || ""} at ${e.organization}`),
  ];
  const candidateTokens = tokenize(candidatePoolParts.join(" "));

  const activeProjects = targetProjectId
    ? context.projects.filter((p) => p.id === targetProjectId)
    : context.projects.filter((p) => p.status === "active");

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 86_400_000;

  for (const project of activeProjects) {
    const projectTopics = (project.topics || []).map((t) => t.trim().toLowerCase());
    const projectTokens = tokenize(`${project.title} ${project.summary || ""}`);

    // Direct topic matches
    const sharedTopics: string[] = [];
    for (const topic of projectTopics) {
      if (candidateTokens.has(topic) || candidatePoolParts.some((p) => p.toLowerCase().includes(topic))) {
        sharedTopics.push(topic);
      }
    }

    // Token overlap between candidate and project title/summary
    let tokenOverlapCount = 0;
    for (const t of projectTokens) {
      if (candidateTokens.has(t)) {
        tokenOverlapCount++;
      }
    }

    if (sharedTopics.length > 0 || tokenOverlapCount >= 2) {
      matchedProjects.push({
        projectId: project.id,
        projectTitle: project.title,
        sharedTopics: Array.from(new Set(sharedTopics)),
      });

      // Topic overlap points: 8 per topic up to 16
      const topicPts = Math.min(16, sharedTopics.length * 8);
      // General token/domain overlap: up to 10
      const tokenPts = Math.min(10, tokenOverlapCount * 3);

      let projectScore = topicPts + tokenPts;

      // Recency boost: +4 if project had activity within 30 days
      const lastActivity = project.lastActivityAt ? new Date(project.lastActivityAt).getTime() : 0;
      if (now - lastActivity < THIRTY_DAYS_MS) {
        projectScore += 4;
      }

      if (projectScore > score) {
        score = projectScore;
      }
    }
  }

  // Also check general user career goals if score has headroom
  if (score < 25 && context.goals.length > 0) {
    for (const goal of context.goals) {
      const goalTokens = tokenize(goal);
      let goalOverlap = 0;
      for (const t of goalTokens) {
        if (candidateTokens.has(t)) goalOverlap++;
      }
      if (goalOverlap >= 2) {
        const goalPts = Math.min(10, goalOverlap * 3);
        score += goalPts;
        reasons.push(`Aligns with career goal: "${goal}"`);
        break;
      }
    }
  }

  // Cap at 30 points
  score = Math.min(30, Math.max(0, score));

  if (matchedProjects.length > 0) {
    const first = matchedProjects[0];
    if (first.sharedTopics.length > 0) {
      reasons.unshift(
        `Working on shared domains (${first.sharedTopics.slice(0, 3).join(", ")}) related to "${first.projectTitle}"`
      );
    } else {
      reasons.unshift(`Relevant background to your project "${first.projectTitle}"`);
    }
  }

  return {
    score,
    matchedProjects,
    reasons,
  };
}
