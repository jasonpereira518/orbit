import type { ParsedCalendarEvent } from "@/lib/calendar-import";

const NETWORKING_TITLE =
  /\b(1\s*[:/.-]?\s*1|one[-\s]?on[-\s]?one|coffee|catch[-\s]?up|catchup|intro(duction)?|networking|chat with|meet with|lunch with|dinner with|sync with|call with|walk with|office hours|informational|mentor|coffee chat|get to know)\b/i;

const EXCLUDE_TITLE =
  /\b(all[\s-]?hands|stand[\s-]?up|standup|sprint|retro(spective)?|planning|all team|team meeting|staff meeting|interview panel|focus time|ooo|out of office|pto|vacation|holiday|birthday|block|hold|busy|doctor|dentist|flight|travel|commute|gym|workout|haircut)\b/i;

export type EventClassification = {
  keep: boolean;
  reason: string;
  kind: "one_on_one" | "networking" | "skip";
  counterpartCount: number;
};

function durationMinutes(event: ParsedCalendarEvent) {
  if (!event.start || !event.end) return null;
  return (event.end.getTime() - event.start.getTime()) / 60000;
}

export function counterpartsOf(
  event: ParsedCalendarEvent,
  selfEmails: string[] = []
) {
  const self = new Set(
    selfEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  const people = [
    ...event.attendees,
    ...(event.organizer ? [event.organizer] : []),
  ];

  const seen = new Set<string>();
  const counterparts: Array<{ name: string; email: string }> = [];

  for (const person of people) {
    const email = (person.email || "").toLowerCase();
    const key = email || person.name.toLowerCase();
    if (!key || seen.has(key)) continue;
    if (email && self.has(email)) continue;
    seen.add(key);
    counterparts.push({ name: person.name, email });
  }

  return counterparts;
}

/**
 * Keep events that look like 1:1s or networking, drop obvious team/admin noise.
 */
export function classifyCalendarEvent(
  event: ParsedCalendarEvent,
  selfEmails: string[] = []
): EventClassification {
  const title = (event.summary || "").trim();
  const counterparts = counterpartsOf(event, selfEmails);
  const count = counterparts.length;
  const minutes = durationMinutes(event);

  if (EXCLUDE_TITLE.test(title)) {
    return {
      keep: false,
      reason: "Looks like a team/admin or personal block",
      kind: "skip",
      counterpartCount: count,
    };
  }

  // Explicit networking / 1:1 language in the title
  if (NETWORKING_TITLE.test(title)) {
    if (count === 0) {
      // Title-only 1:1 like "Coffee with Jane" — still useful
      return {
        keep: true,
        reason: "Title suggests a 1:1 or networking chat",
        kind: "networking",
        counterpartCount: count,
      };
    }
    if (count <= 3) {
      return {
        keep: true,
        reason: "Title suggests a 1:1 or networking chat",
        kind: count === 1 ? "one_on_one" : "networking",
        counterpartCount: count,
      };
    }
  }

  // Classic 1:1: exactly one other person, reasonable duration
  if (count === 1) {
    if (minutes !== null && (minutes < 10 || minutes > 180)) {
      return {
        keep: false,
        reason: "Single attendee but unusual duration",
        kind: "skip",
        counterpartCount: count,
      };
    }
    return {
      keep: true,
      reason: "One other attendee (likely 1:1)",
      kind: "one_on_one",
      counterpartCount: count,
    };
  }

  // Small meeting with 2 others + networking-ish duration
  if (count === 2 && minutes !== null && minutes >= 20 && minutes <= 90) {
    if (/\b(with|intro|meet|coffee|chat)\b/i.test(title)) {
      return {
        keep: true,
        reason: "Small meeting that looks like an intro",
        kind: "networking",
        counterpartCount: count,
      };
    }
  }

  // Title like "Jane Doe <> Jason" or "Jane / Jason"
  if (/\b\w+\s*[<>/|]+\s*\w+\b/.test(title) && count <= 2) {
    return {
      keep: true,
      reason: "Title looks like a paired 1:1",
      kind: "one_on_one",
      counterpartCount: count,
    };
  }

  return {
    keep: false,
    reason: "Does not look like a 1:1 or networking event",
    kind: "skip",
    counterpartCount: count,
  };
}

/** Extract a person name from titles like "Coffee with Jane Doe" when attendees are missing. */
export function nameFromNetworkingTitle(summary: string): string | null {
  const withMatch = summary.match(
    /\b(?:with|\/|<>)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/
  );
  if (withMatch?.[1]) return withMatch[1].trim();

  const pair = summary.match(
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[<>/|]+\s*[A-Z]/
  );
  if (pair?.[1]) return pair[1].trim();

  return null;
}
