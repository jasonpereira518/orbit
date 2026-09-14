import type { ParsedCalendarEvent } from "@/lib/calendar-import";

const NETWORKING_TITLE =
  /\b(1\s*[:/.-]?\s*1|one[-\s]?on[-\s]?one|coffee|catch[-\s]?up|catchup|intro(duction)?|networking|coffee chat|get to know|office hours|informational|mentor|meet(?:ing)?\s+with|chat\s+with|lunch\s+with|dinner\s+with|sync\s+with|call\s+with|walk\s+with|zoom\s+with|hang\s+with)\b/i;

const EXCLUDE_TITLE =
  /\b(all[\s-]?hands|stand[\s-]?up|standup|sprint|retro(spective)?|planning|all team|team meeting|staff meeting|interview panel|focus time|ooo|out of office|pto|vacation|holiday|birthday|block|hold|busy|doctor|dentist|flight|travel|commute|gym|workout|haircut)\b/i;

/**
 * A panel, webinar, or talk — hosted by someone, attended by many. Distinct from
 * `NETWORKING_TITLE`: these events are worth a contact touch for the HOST (if you attended)
 * or the ATTENDEES (if you hosted it), not for every name on a large invite list. Checked
 * after `EXCLUDE_TITLE`, so an internal "town hall" or "all-hands" is never reclassified here.
 */
const GROUP_EVENT_TITLE =
  /\b(webinar|panel(?:\s+discussion)?|fireside(?:\s+chat)?|\bama\b|keynote|workshop|meetup|summit|conference|masterclass|roundtable|demo\s*day|pitch\s*(?:night|event|day))\b/i;

const PERSON_NAME =
  /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/;

export type EventClassification = {
  keep: boolean;
  reason: string;
  kind: "one_on_one" | "networking" | "group_event" | "skip";
  counterpartCount: number;
};

function durationMinutes(event: ParsedCalendarEvent) {
  if (!event.start || !event.end) return null;
  return (event.end.getTime() - event.start.getTime()) / 60000;
}

/**
 * People on the event excluding the calendar owner.
 * Google Calendar ICS feeds usually omit ATTENDEE lines; the ORGANIZER is the
 * calendar owner, not a guest — so we only use organizer when real attendees exist
 * and self emails weren't provided to filter them.
 */
export function counterpartsOf(
  event: ParsedCalendarEvent,
  selfEmails: string[] = []
) {
  const self = new Set(
    selfEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  const attendees = event.attendees.filter((p) => p.email || p.name);
  const people =
    attendees.length > 0
      ? [
          ...attendees,
          // Organizer may also be listed; include only if not clearly self
          ...(event.organizer ? [event.organizer] : []),
        ]
      : // No attendees (typical Google ICS) — never treat organizer as a guest
        [];

  const seen = new Set<string>();
  const counterparts: Array<{ name: string; email: string }> = [];

  for (const person of people) {
    const email = (person.email || "").toLowerCase();
    const key = email || person.name.toLowerCase();
    if (!key || seen.has(key)) continue;
    if (email && self.has(email)) continue;
    seen.add(key);
    counterparts.push({
      name: person.name || email.split("@")[0] || "Contact",
      email,
    });
  }

  return counterparts;
}

export type GroupEventParticipants = {
  /** Whether the calendar owner organized this event (role: "hosted") vs. merely attended it. */
  hostedBySelf: boolean;
  /** The organizer, when it is someone other than the calendar owner. Null if self-organized. */
  organizer: { name: string; email: string } | null;
  /** Everyone else on the invite, self and the organizer (when already counted) excluded. */
  attendees: Array<{ name: string; email: string }>;
};

/**
 * Who matters for a `group_event` classification, split by role rather than collapsed into one
 * "counterparts" list — unlike a 1:1, a panel/webinar needs to tell its host apart from its
 * attendees, because which one becomes a roster entry depends on who's on Orbit's side of it.
 */
export function groupEventParticipants(
  event: ParsedCalendarEvent,
  selfEmails: string[] = []
): GroupEventParticipants {
  const self = new Set(
    selfEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  const organizerEmail = (event.organizer?.email || "").toLowerCase();
  const hostedBySelf = Boolean(organizerEmail && self.has(organizerEmail));
  const organizer =
    event.organizer && !hostedBySelf && (event.organizer.email || event.organizer.name)
      ? event.organizer
      : null;

  const seen = new Set<string>();
  if (organizerEmail) seen.add(organizerEmail);
  const attendees: Array<{ name: string; email: string }> = [];
  for (const person of event.attendees) {
    const email = (person.email || "").toLowerCase();
    const key = email || person.name.toLowerCase();
    if (!key || seen.has(key)) continue;
    if (email && self.has(email)) continue;
    seen.add(key);
    if (!person.email && !person.name) continue;
    attendees.push({
      name: person.name || email.split("@")[0] || "Guest",
      email,
    });
  }

  return { hostedBySelf, organizer, attendees };
}

/** Pull guest names/emails from DESCRIPTION when ATTENDEE is missing (Google ICS). */
export function peopleFromDescription(description: string): Array<{
  name: string;
  email: string;
}> {
  if (!description.trim()) return [];

  const people: Array<{ name: string; email: string }> = [];
  const seen = new Set<string>();

  const add = (name: string, email: string) => {
    const key = (email || name).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    people.push({ name: name.trim() || email.split("@")[0] || "Contact", email });
  };

  // "Guests: Jane Doe <jane@x.com>, Bob <bob@y.com>"
  const guestsLine = description.match(
    /(?:^|\n)\s*Guests?:\s*([^\n]+)/i
  )?.[1];
  if (guestsLine) {
    for (const part of guestsLine.split(/[,;]/)) {
      const email =
        part.match(/<([^>]+@[^>]+)>/)?.[1]?.toLowerCase() ||
        part.match(/([\w.+-]+@[\w.-]+)/)?.[1]?.toLowerCase() ||
        "";
      const name = part
        .replace(/<[^>]+>/, "")
        .replace(/[\w.+-]+@[\w.-]+/, "")
        .replace(/[<>]/g, "")
        .trim();
      if (name || email) add(name, email);
    }
  }

  // mailto: links scattered in the description
  for (const match of description.matchAll(/mailto:([\w.+-]+@[\w.-]+)/gi)) {
    add("", match[1]!.toLowerCase());
  }

  return people;
}

/**
 * Keep events that look like 1:1s or networking, drop obvious team/admin noise.
 * Google ICS often has titles only (no attendees) — those still count when the
 * title names a person or uses networking language.
 */
export function classifyCalendarEvent(
  event: ParsedCalendarEvent,
  selfEmails: string[] = []
): EventClassification {
  const title = (event.summary || "").trim();
  const fromAttendees = counterpartsOf(event, selfEmails);
  const fromDescription = peopleFromDescription(event.description || "").filter(
    (p) => {
      const email = p.email.toLowerCase();
      return !email || !selfEmails.some((s) => s.toLowerCase() === email);
    }
  );
  const counterparts =
    fromAttendees.length > 0 ? fromAttendees : fromDescription;
  const count = counterparts.length;
  const minutes = durationMinutes(event);
  const titleName = nameFromNetworkingTitle(title);

  if (EXCLUDE_TITLE.test(title)) {
    return {
      keep: false,
      reason: "Looks like a team/admin or personal block",
      kind: "skip",
      counterpartCount: count,
    };
  }

  // Panel/webinar/talk language, checked before the 1:1 heuristics below so a
  // "Fireside chat" with a handful of named attendees isn't mistaken for small-group
  // networking. Kept regardless of attendee count — the roster review, not this
  // classifier, is what protects the contact allowance from a huge invite list.
  if (GROUP_EVENT_TITLE.test(title)) {
    return {
      keep: true,
      reason: "Title suggests a panel, webinar, or hosted talk",
      kind: "group_event",
      counterpartCount: count,
    };
  }

  // Explicit networking / 1:1 language in the title
  if (NETWORKING_TITLE.test(title)) {
    if (count === 0 || count <= 3) {
      return {
        keep: true,
        reason: "Title suggests a 1:1 or networking chat",
        kind: count === 1 ? "one_on_one" : "networking",
        counterpartCount: count || (titleName ? 1 : 0),
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
      counterpartCount: count || 1,
    };
  }

  // Google ICS: no guests, title is just a person name + short meeting
  if (count === 0 && titleName) {
    if (minutes === null || (minutes >= 15 && minutes <= 120)) {
      return {
        keep: true,
        reason: "Title names a person (likely 1:1; calendar feed had no guests)",
        kind: "one_on_one",
        counterpartCount: 1,
      };
    }
  }

  return {
    keep: false,
    reason: "Does not look like a 1:1 or networking event",
    kind: "skip",
    counterpartCount: count,
  };
}

/**
 * Extract a person name from titles when attendees are missing
 * (common with Google Calendar ICS).
 */
export function nameFromNetworkingTitle(summary: string): string | null {
  const cleaned = summary
    .replace(/\s*[\([{].*?[)\]}]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || EXCLUDE_TITLE.test(cleaned)) return null;

  const patterns = [
    // "Coffee with Jane Doe", "Meeting with Jane", "Call with Jane D"
    /\b(?:with|\/|<>)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/,
    // "1:1 Jane Doe", "1-1 Jane Doe"
    /\b1\s*[:/.-]?\s*1\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/i,
    // "Jane Doe 1:1"
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+1\s*[:/.-]?\s*1\b/i,
    // "Jane Doe <> Jason" / "Jane / Jason"
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[<>/|]+\s*[A-Z]/,
    // "Call: Jane Doe" / "Sync - Jane Doe"
    /^(?:call|sync|chat|meet(?:ing)?|zoom|intro)\s*[:\-–—]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1] && !EXCLUDE_TITLE.test(match[1])) {
      return match[1].trim();
    }
  }

  // Entire title is a plausible person name ("Jane Doe")
  if (PERSON_NAME.test(cleaned) && cleaned.includes(" ")) {
    return cleaned;
  }

  return null;
}
