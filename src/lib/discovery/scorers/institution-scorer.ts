/**
 * Institutional and Company Affinity Scorer
 *
 * Scores shared schools, shared former employers, and target company status.
 * Range: 0 to 15 points.
 */

import { normalizeCompanyKey } from "@/lib/company-name";
import type { InstitutionalTies, RawCandidate, UserDiscoveryContext } from "../types";

export type InstitutionScoreResult = {
  score: number;
  institutionalTies: InstitutionalTies | null;
  reasons: string[];
};

function normalizeSchool(school: string): string {
  return school
    .toLowerCase()
    .replace(/\b(university|college|institute|of|at|the)\b/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

export function scoreInstitutionalAffinity(
  candidate: RawCandidate,
  context: UserDiscoveryContext
): InstitutionScoreResult {
  let score = 0;
  const reasons: string[] = [];

  let matchedSchool: string | null = null;
  let matchedPastEmployer: string | null = null;
  let targetCompanyPriority: 1 | 2 | 3 | null = null;
  let matchedCompanyName: string | null = null;

  // 1. Check School / Alma Mater
  const userSchoolNorms = (context.schools || []).map((s) => ({
    original: s,
    norm: normalizeSchool(s),
  }));

  const candidateSchools = candidate.schoolHistory || [];
  if (candidate.signals) {
    for (const sig of candidate.signals) {
      if (sig.startsWith("Alum:") || sig.startsWith("School:")) {
        candidateSchools.push(sig.split(":")[1].trim());
      }
    }
  }

  for (const cSchool of candidateSchools) {
    const cNorm = normalizeSchool(cSchool);
    if (!cNorm) continue;
    const match = userSchoolNorms.find(
      (u) => u.norm.length > 2 && (u.norm.includes(cNorm) || cNorm.includes(u.norm))
    );
    if (match) {
      score += 10;
      matchedSchool = match.original;
      reasons.push(`Fellow ${match.original} alum`);
      break;
    }
  }

  // 2. Check Shared Past Employer with User
  const candidateCompanyKeys = new Set<string>();
  if (candidate.company) {
    candidateCompanyKeys.add(normalizeCompanyKey(candidate.company));
  }
  for (const exp of candidate.experienceHistory || []) {
    candidateCompanyKeys.add(normalizeCompanyKey(exp.organization));
  }

  const userPastCompanyKeys = (context.userPastCompanies || []).map(normalizeCompanyKey);
  for (const uCompany of userPastCompanyKeys) {
    if (uCompany && candidateCompanyKeys.has(uCompany)) {
      score += 10;
      matchedPastEmployer = uCompany;
      reasons.push(`Shared former employer (${uCompany})`);
      break;
    }
  }

  // 3. Check Target Company Priority
  const candidateCurrCompanyKey = candidate.company
    ? normalizeCompanyKey(candidate.company)
    : "";

  if (candidateCurrCompanyKey) {
    for (const tc of context.targetCompanies || []) {
      const tcKey = normalizeCompanyKey(tc.name);
      if (tcKey === candidateCurrCompanyKey) {
        matchedCompanyName = tc.name;
        if (tc.priority === 1) {
          score += 12;
          targetCompanyPriority = 1;
          reasons.push(`Works at your Dream target company (${tc.name})`);
        } else if (tc.priority === 2) {
          score += 8;
          targetCompanyPriority = 2;
          reasons.push(`Works at your Target company (${tc.name})`);
        } else {
          score += 5;
          targetCompanyPriority = 3;
          reasons.push(`Works at your Curious target company (${tc.name})`);
        }
        break;
      }
    }
  }

  // Cap at 15 points
  score = Math.min(15, Math.max(0, score));

  const ties: InstitutionalTies | null =
    matchedSchool || matchedPastEmployer || targetCompanyPriority
      ? {
          sharedSchool: matchedSchool,
          sharedPastEmployer: matchedPastEmployer,
          targetCompanyPriority,
          companyName: matchedCompanyName || candidate.company || null,
        }
      : null;

  return {
    score,
    institutionalTies: ties,
    reasons,
  };
}
