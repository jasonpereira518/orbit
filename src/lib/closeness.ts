import { daysAgo } from "@/lib/duplicates";

export type ClosenessContact = {
  relationshipScore?: number | null;
  lastInteractionAt?: Date | string | null;
  createdAt?: Date | string | null;
  company?: string | null;
  title?: string | null;
  industry?: string | null;
  howMet?: string | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: string[] | null;
  sharedInterests?: string[] | null;
  tags?: string[] | null;
};

export type ClosenessBreakdown = {
  closeness: number;
  strength: number;
  recency: number;
  goalRelevance: number;
  /** 1–5 ring band derived from closeness for orbit placement */
  orbitScore: number;
  tier: "inner" | "mid" | "outer";
};

/** Half-life (~31d when tau=45): score ≈ 0.37 after 45 days without contact. */
const RECENCY_TAU_DAYS = 45;

export function strengthComponent(relationshipScore?: number | null) {
  const s = Math.min(5, Math.max(1, relationshipScore || 2));
  return s / 5;
}

export function recencyComponent(
  lastInteractionAt?: Date | string | null,
  createdAt?: Date | string | null
) {
  const ref = lastInteractionAt || createdAt;
  if (!ref) return 0.15;
  const days = daysAgo(ref);
  if (days <= 0) return 1;
  return Math.exp(-days / RECENCY_TAU_DAYS);
}

export function goalRelevanceComponent(
  contact: ClosenessContact,
  activeGoals: string[]
) {
  const goals = activeGoals.map((g) => g.trim()).filter(Boolean);
  if (!goals.length) return 0;

  const haystack = [
    contact.company,
    contact.title,
    contact.industry,
    contact.howMet,
    contact.notes,
    contact.aiSummary,
    ...(contact.keyFacts || []),
    ...(contact.sharedInterests || []),
    ...(contact.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) return 0;

  let hits = 0;
  for (const goal of goals) {
    const tokens = goal
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/i)
      .filter((t) => t.length > 2);
    if (tokens.length === 0) {
      if (haystack.includes(goal.toLowerCase())) hits++;
      continue;
    }
    if (tokens.some((t) => haystack.includes(t))) hits++;
  }

  return hits / goals.length;
}

export function closenessTier(closeness: number): ClosenessBreakdown["tier"] {
  if (closeness >= 0.55) return "inner";
  if (closeness >= 0.25) return "mid";
  return "outer";
}

/** Map continuous closeness onto the five constellation rings. */
export function closenessToOrbitScore(closeness: number) {
  if (closeness >= 0.7) return 5;
  if (closeness >= 0.55) return 4;
  if (closeness >= 0.4) return 3;
  if (closeness >= 0.25) return 2;
  return 1;
}

/**
 * Closeness = 50% manual strength + 30% recency decay + 20% goal relevance.
 */
export function computeCloseness(
  contact: ClosenessContact,
  activeGoals: string[] = []
): ClosenessBreakdown {
  const strength = strengthComponent(contact.relationshipScore);
  const recency = recencyComponent(
    contact.lastInteractionAt,
    contact.createdAt
  );
  const goalRelevance = goalRelevanceComponent(contact, activeGoals);
  const closeness = Math.min(
    1,
    Math.max(0, 0.5 * strength + 0.3 * recency + 0.2 * goalRelevance)
  );

  return {
    closeness,
    strength,
    recency,
    goalRelevance,
    orbitScore: closenessToOrbitScore(closeness),
    tier: closenessTier(closeness),
  };
}
