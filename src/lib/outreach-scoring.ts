/**
 * Outreach Prospect Effectiveness Scoring Engine
 *
 * Scores prospects from 0 to 100 based on multiple weighted dimensions:
 * 1. Title & Seniority Relevance (0-35 pts)
 * 2. News Catalyst Urgency & Freshness (0-30 pts)
 * 3. Warm Connection & Network Affinity (0-20 pts)
 * 4. Contactability & Verification (0-15 pts)
 *
 * Higher scoring prospects have significantly higher positive response probabilities.
 */

export type ScoreBreakdown = {
  score: number;
  tier: "high" | "strong" | "standard";
  reasons: string[];
};

export type ProspectScoreInput = {
  title?: string | null;
  company?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  hasWarmPath?: boolean;
  warmPathCount?: number;
  newsContext?: string | null;
  signals?: string[];
  targetTitles?: string[];
  targetSeniorities?: string[];
  targetCompanies?: string[];
};

export function calculateProspectEffectiveness(input: ProspectScoreInput): ScoreBreakdown {
  let score = 25; // baseline base score
  const reasons: string[] = [];

  const titleLower = (input.title || "").toLowerCase();
  const companyLower = (input.company || "").toLowerCase();

  // 1. Title & Seniority Relevance (0 - 35 points)
  let titleScore = 10;
  const isExec = /founder|co-founder|ceo|cto|cpo|cro|cmo|coo|chief|president/i.test(titleLower);
  const isVP = /vp|vice president|head of|director/i.test(titleLower);
  const isLead = /lead|principal|staff|manager/i.test(titleLower);

  if (isExec) {
    titleScore = 35;
    reasons.push("Executive decision-maker (+35)");
  } else if (isVP) {
    titleScore = 30;
    reasons.push("VP / Department Head (+30)");
  } else if (isLead) {
    titleScore = 25;
    reasons.push("Team Lead / Principal (+25)");
  } else if (input.title) {
    titleScore = 18;
    reasons.push("Relevant role match (+18)");
  }

  // Check against explicit target titles
  if (input.targetTitles?.length) {
    const directMatch = input.targetTitles.some((t) => titleLower.includes(t.toLowerCase()));
    if (directMatch) {
      titleScore = Math.min(35, titleScore + 10);
      reasons.push("Direct target title match (+10)");
    }
  }

  score += titleScore;

  // 2. News Catalyst Urgency & Freshness (0 - 30 points)
  let catalystScore = 0;
  const newsLower = (input.newsContext || "").toLowerCase();
  const hasSignals = Boolean(input.signals && input.signals.length > 0);

  if (/series [a-d]|funding|raised|seed round|\$\d+m/i.test(newsLower)) {
    catalystScore = 30;
    reasons.push("Recent funding milestone catalyst (+30)");
  } else if (/launch|producthunt|rollout|expansion|acquired|partnership/i.test(newsLower)) {
    catalystScore = 25;
    reasons.push("Product launch or expansion catalyst (+25)");
  } else if (input.newsContext) {
    catalystScore = 18;
    reasons.push("Verified company news trigger (+18)");
  } else if (hasSignals) {
    catalystScore = 12;
    reasons.push("Active company growth signals (+12)");
  }

  score += catalystScore;

  // 3. Warm Connection & Network Affinity (0 - 20 points)
  if (input.hasWarmPath || (input.warmPathCount && input.warmPathCount > 0)) {
    const pts = Math.min(20, 15 + (input.warmPathCount ? input.warmPathCount * 2 : 5));
    score += pts;
    reasons.push(`Network path: you know someone at ${input.company || "this company"} (+${pts})`);
  }

  // 4. Contactability & Data Verification (0 - 15 points)
  let dataScore = 0;
  if (input.email && !input.email.includes("@example.com") && !input.email.includes(".test")) {
    dataScore += 8;
  }
  if (input.linkedinUrl && input.linkedinUrl.includes("linkedin.com/in/")) {
    dataScore += 7;
    reasons.push("Verified LinkedIn profile link (+7)");
  }
  score += dataScore;

  // Normalize final score to 15-99 scale
  const finalScore = Math.min(99, Math.max(20, score));

  let tier: "high" | "strong" | "standard" = "standard";
  if (finalScore >= 80) tier = "high";
  else if (finalScore >= 60) tier = "strong";

  return {
    score: finalScore,
    tier,
    reasons: reasons.slice(0, 3),
  };
}
