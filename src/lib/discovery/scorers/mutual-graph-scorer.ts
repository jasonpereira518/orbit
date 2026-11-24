/**
 * Mutual Connections and Warm Intro Graph Scorer
 *
 * Discovers potential introducers in the user's 1st-degree contacts who can introduce
 * the user to the candidate based on shared workplace tenure, shared events, or shared company.
 * Range: 0 to 25 points.
 */

import { normalizeCompanyKey } from "@/lib/company-name";
import type { IntroPath, RawCandidate } from "../types";

export type ContactNetworkNode = {
  contactId: string;
  fullName: string;
  company?: string | null;
  closenessTier?: "inner" | "mid" | "outer" | null;
  relationshipScore?: number | null;
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  experiences?: Array<{
    organization: string;
    organizationNormalized: string;
    title?: string | null;
    startYear?: number | null;
    endYear?: number | null;
    isCurrent?: boolean;
  }>;
  attendedEventIds?: string[];
};

export type MutualScoreResult = {
  score: number;
  bestIntroPath: IntroPath | null;
  reasons: string[];
};

function checkTenureOverlap(
  start1?: number | null,
  end1?: number | null,
  isCurrent1?: boolean,
  start2?: number | null,
  end2?: number | null,
  isCurrent2?: boolean
): { overlaps: boolean; overlapLabel?: string } {
  const currentYear = new Date().getFullYear();
  const e1 = isCurrent1 ? currentYear : end1 ?? (start1 ? start1 + 2 : null);
  const s1 = start1 ?? (e1 ? e1 - 2 : null);

  const e2 = isCurrent2 ? currentYear : end2 ?? (start2 ? start2 + 2 : null);
  const s2 = start2 ?? (e2 ? e2 - 2 : null);

  if (s1 != null && e1 != null && s2 != null && e2 != null) {
    const overlapStart = Math.max(s1, s2);
    const overlapEnd = Math.min(e1, e2);
    if (overlapStart <= overlapEnd) {
      const overlapLabel =
        overlapStart === overlapEnd
          ? `around ${overlapStart}`
          : `${overlapStart}-${overlapEnd}`;
      return { overlaps: true, overlapLabel };
    }
  }

  // If both are current, they definitely overlap
  if (isCurrent1 && isCurrent2) {
    return { overlaps: true, overlapLabel: "currently" };
  }

  return { overlaps: false };
}

export function scoreMutualIntroPath(
  candidate: RawCandidate,
  contacts: ContactNetworkNode[]
): MutualScoreResult {
  let highestScore = 0;
  let bestIntroPath: IntroPath | null = null;
  const reasons: string[] = [];

  // Build candidate company map
  type CandidateOrg = {
    key: string;
    label: string;
    startYear?: number | null;
    endYear?: number | null;
    isCurrent?: boolean;
  };
  const candidateOrgs: CandidateOrg[] = [];

  if (candidate.company) {
    candidateOrgs.push({
      key: normalizeCompanyKey(candidate.company),
      label: candidate.company,
      isCurrent: true,
    });
  }

  for (const exp of candidate.experienceHistory || []) {
    const key = normalizeCompanyKey(exp.organization);
    if (key && !candidateOrgs.some((o) => o.key === key)) {
      candidateOrgs.push({
        key,
        label: exp.organization,
        startYear: exp.startYear,
        endYear: exp.endYear,
        isCurrent: exp.isCurrent,
      });
    }
  }

  const candidateSharedEventIds = new Set(
    (candidate.sharedEvents || []).map((e) => e.eventId)
  );

  for (const contact of contacts) {
    const tier = contact.closenessTier || "mid";
    const tierMultiplier = tier === "inner" ? 1.0 : tier === "mid" ? 0.8 : 0.5;
    const relScore = contact.relationshipScore || 50;

    let candidatePoints = 0;
    let contextDescription = "";
    let isDirectTenureOverlap = false;

    // 1. Check company tenure overlap with contact experiences
    for (const cExp of contact.experiences || []) {
      const matchedOrg = candidateOrgs.find((o) => o.key === cExp.organizationNormalized);
      if (!matchedOrg) continue;

      const overlapCheck = checkTenureOverlap(
        cExp.startYear,
        cExp.endYear,
        cExp.isCurrent,
        matchedOrg.startYear,
        matchedOrg.endYear,
        matchedOrg.isCurrent
      );

      if (overlapCheck.overlaps) {
        candidatePoints = Math.max(candidatePoints, 22);
        contextDescription = `Colleague at ${cExp.organization} (${overlapCheck.overlapLabel})`;
        isDirectTenureOverlap = true;
        break;
      } else {
        // Same company, but non-overlapping or unknown dates
        const pts = cExp.isCurrent && matchedOrg.isCurrent ? 16 : 10;
        if (pts > candidatePoints) {
          candidatePoints = pts;
          contextDescription =
            cExp.isCurrent && matchedOrg.isCurrent
              ? `Both currently at ${matchedOrg.label}`
              : `Alumni of ${matchedOrg.label}`;
        }
      }
    }

    // Also check contact.company (CSV imported company)
    if (!candidatePoints && contact.company) {
      const contactCompanyKey = normalizeCompanyKey(contact.company);
      const matchedOrg = candidateOrgs.find((o) => o.key === contactCompanyKey);
      if (matchedOrg) {
        candidatePoints = 12;
        contextDescription = `Both associated with ${matchedOrg.label}`;
      }
    }

    // 2. Check event co-attendance between contact and candidate
    if (contact.attendedEventIds && candidateSharedEventIds.size > 0) {
      const commonEvents = contact.attendedEventIds.filter((id) =>
        candidateSharedEventIds.has(id)
      );
      if (commonEvents.length > 0) {
        const eventPoints = Math.min(18, 10 + commonEvents.length * 4);
        if (eventPoints > candidatePoints) {
          candidatePoints = eventPoints;
          contextDescription = `Co-attended ${commonEvents.length} mutual event${commonEvents.length > 1 ? "s" : ""}`;
        }
      }
    }

    if (candidatePoints > 0) {
      // Weight by relationship strength
      const weightedScore = Math.round(candidatePoints * tierMultiplier);
      const feasibility: "high" | "medium" =
        (tier === "inner" || relScore >= 65 || isDirectTenureOverlap) && tier !== "outer"
          ? "high"
          : "medium";

      if (weightedScore > highestScore) {
        highestScore = weightedScore;
        bestIntroPath = {
          introducerContactId: contact.contactId,
          introducerName: contact.fullName,
          introducerTier: tier,
          relationshipScore: relScore,
          relationshipContext: contextDescription,
          introFeasibility: feasibility,
          profileImageUrl: contact.profileImageUrl,
          linkedinUrl: contact.linkedinUrl,
          email: contact.email,
        };
      }
    }
  }

  // Cap at 25 points
  highestScore = Math.min(25, highestScore);

  if (bestIntroPath) {
    reasons.push(
      `Warm introduction available via ${bestIntroPath.introducerName} (${bestIntroPath.relationshipContext})`
    );
  }

  return {
    score: highestScore,
    bestIntroPath,
    reasons,
  };
}
