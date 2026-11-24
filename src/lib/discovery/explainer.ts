/**
 * Transparent Discovery Explainer
 *
 * Synthesizes honest, grounded match explanations without AI hallucinations.
 */

import type {
  EventOverlapDetails,
  InstitutionalTies,
  IntroPath,
  MatchedProject,
  RawCandidate,
} from "./types";

export type ExplainerInput = {
  candidate: RawCandidate;
  score: number;
  matchedProjects: MatchedProject[];
  introPath?: IntroPath | null;
  eventOverlap?: EventOverlapDetails | null;
  institutionalTies?: InstitutionalTies | null;
  reasons: string[];
};

export type ExplainerOutput = {
  primaryWhy: string;
  bulletReasons: string[];
  suggestedOpener: string;
};

export function synthesizeExplanation(input: ExplainerInput): ExplainerOutput {
  const { candidate, matchedProjects, introPath, eventOverlap, institutionalTies } = input;

  const candidateRoleDesc = [candidate.title, candidate.company].filter(Boolean).join(" at ");

  // 1. Determine Primary Hook
  let primaryWhy = "";
  if (introPath && matchedProjects.length > 0) {
    primaryWhy = `${candidateRoleDesc || candidate.fullName} aligns with your project "${matchedProjects[0].projectTitle}"; warm intro available via ${introPath.introducerName}.`;
  } else if (introPath) {
    primaryWhy = `Warm introduction available via ${introPath.introducerName} (${introPath.relationshipContext}).`;
  } else if (eventOverlap && eventOverlap.upcomingSharedEvent) {
    primaryWhy = `Both attending upcoming "${eventOverlap.upcomingSharedEvent}".`;
  } else if (eventOverlap && eventOverlap.coAttendedCount > 0) {
    primaryWhy = `Co-attended ${eventOverlap.coAttendedCount} previous event${eventOverlap.coAttendedCount > 1 ? "s" : ""} with you.`;
  } else if (matchedProjects.length > 0) {
    const proj = matchedProjects[0];
    const topicsStr = proj.sharedTopics.length ? ` focusing on ${proj.sharedTopics.slice(0, 2).join(", ")}` : "";
    primaryWhy = `Relevant to your project "${proj.projectTitle}"${topicsStr}.`;
  } else if (institutionalTies?.sharedSchool) {
    primaryWhy = `Fellow ${institutionalTies.sharedSchool} alum${candidate.company ? ` at ${candidate.company}` : ""}.`;
  } else if (institutionalTies?.targetCompanyPriority) {
    primaryWhy = `Works at your target company ${candidate.company || ""}.`;
  } else {
    primaryWhy = candidateRoleDesc
      ? `${candidateRoleDesc} matching your focus.`
      : `${candidate.fullName} matches your network discovery criteria.`;
  }

  // 2. Format Bullet Reasons (filter duplicates & order strongest first)
  const uniqueReasons = Array.from(new Set(input.reasons)).slice(0, 4);

  // 3. Formulate Suggested Opener
  let suggestedOpener = "";
  if (introPath) {
    suggestedOpener = `Mentioned by ${introPath.introducerName} — saw your work on ${candidate.company || "projects"} and would love to connect.`;
  } else if (eventOverlap && eventOverlap.upcomingSharedEvent) {
    suggestedOpener = `Looking forward to ${eventOverlap.upcomingSharedEvent}! Saw you'll be there and would love to say hello.`;
  } else if (eventOverlap && eventOverlap.sharedEventNames.length > 0) {
    suggestedOpener = `Saw we both attended ${eventOverlap.sharedEventNames[0]} — really admired your work and wanted to connect!`;
  } else if (matchedProjects.length > 0) {
    suggestedOpener = `Saw your background in ${matchedProjects[0].sharedTopics[0] || "this domain"} — currently building ${matchedProjects[0].projectTitle} and would love your perspective.`;
  } else if (institutionalTies?.sharedSchool) {
    suggestedOpener = `Fellow ${institutionalTies.sharedSchool} alum reaching out! Would love to connect and learn more about your path.`;
  } else {
    suggestedOpener = `Came across your profile and was really impressed by your work at ${candidate.company || "your team"}. Would love to connect!`;
  }

  return {
    primaryWhy,
    bulletReasons: uniqueReasons,
    suggestedOpener,
  };
}
