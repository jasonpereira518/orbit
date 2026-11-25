/**
 * Event and Community Overlap Scorer
 *
 * Scores shared event attendance history and upcoming gathering overlap with the user.
 * Range: 0 to 20 points.
 */

import type { EventOverlapDetails, RawCandidate, UserDiscoveryContext } from "../types";

export type EventScoreResult = {
  score: number;
  eventOverlap: EventOverlapDetails | null;
  reasons: string[];
};

export function scoreEventProximity(
  candidate: RawCandidate,
  _context?: UserDiscoveryContext
): EventScoreResult {
  let score = 0;
  const reasons: string[] = [];

  const candidateEvents = candidate.sharedEvents || [];
  if (candidateEvents.length === 0) {
    return { score: 0, eventOverlap: null, reasons: [] };
  }

  const pastEvents = candidateEvents.filter((e) => !e.isUpcoming);
  const upcomingEvents = candidateEvents.filter((e) => e.isUpcoming);

  // 1. Shared past events: +8 per event, up to 16
  const pastPoints = Math.min(16, pastEvents.length * 8);
  score += pastPoints;

  // 2. Upcoming shared events: +12 if both are attending an upcoming gathering
  let upcomingTitle: string | null = null;
  if (upcomingEvents.length > 0) {
    score += 12;
    upcomingTitle = upcomingEvents[0].eventTitle;
    reasons.push(`Both attending upcoming event: "${upcomingTitle}"`);
  }

  // 3. Speaker / Host role bonus: +4 points if candidate was a speaker or host
  if (candidate.signals?.some((s) => /speaker|host/i.test(s))) {
    score += 4;
    reasons.push("Featured speaker/host at shared event");
  }

  if (pastEvents.length > 0) {
    const titles = pastEvents.map((e) => e.eventTitle).slice(0, 2);
    reasons.push(
      `Co-attended ${pastEvents.length} event${pastEvents.length > 1 ? "s" : ""} with you (${titles.join(", ")})`
    );
  }

  // Cap at 20 points
  score = Math.min(20, Math.max(0, score));

  const eventOverlap: EventOverlapDetails = {
    coAttendedCount: pastEvents.length,
    sharedEventNames: candidateEvents.map((e) => e.eventTitle),
    upcomingSharedEvent: upcomingTitle,
  };

  return {
    score,
    eventOverlap,
    reasons,
  };
}
