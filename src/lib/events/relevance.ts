/**
 * Who, out of everyone in this room, is worth walking up to.
 *
 * ## Why this is a score and not a model
 *
 * The answer has to be EXPLAINABLE. "Talk to Priya" is useless; "Recruiter at Stripe, one of
 * your target companies, and you know two people there" is something a person can act on
 * while standing in a doorway. Every point below therefore comes with a reason, and the card
 * shows the reasons rather than the number.
 *
 * It also has to be STABLE. A ranking that reshuffles between two page loads teaches the user
 * not to trust it. Same inputs, same order, every time — which a model cannot promise and a
 * pure function can. (The optional AI step writes prose about a row this has already chosen;
 * it never changes the choosing.)
 *
 * ## What is deliberately NOT here
 *
 * Seniority is a weak, biased signal and it is weighted accordingly. A VP is not automatically
 * more useful than the engineer who actually does the work, and ranking purely by title would
 * turn the feature into a status ladder. It earns points only where it genuinely predicts
 * usefulness — a recruiter at a careers fair — and is otherwise a tiebreaker.
 *
 * Nothing here reads closeness's raw score. It reads the materialised TIER, because the
 * question is different: closeness asks "how well do you know them", this asks "is talking to
 * them today worth the walk across the room", and the answer to the second is often "no,
 * you speak every week".
 *
 * Pure: no network, no database, no AI.
 */
import type { EventKind } from "@/lib/events/company-list-parse";

/**
 * Every weight in one object, because they only make sense relative to each other.
 *
 * Exported so the smoke test can assert the ORDERING rather than re-typing the numbers — a
 * test that hard-codes 35 fails on every tuning pass and teaches nothing.
 */
export const RELEVANCE_WEIGHTS = {
  /** By priority: 1 dream, 2 target, 3 curious. The strongest single signal. */
  targetCompany: { 1: 35, 2: 25, 3: 12 },
  /** Scaled by `goalRelevanceComponent`, which is already 0..1. */
  goalMatch: 20,
  /** Per event beyond the first, capped — five shared rooms is not five times two. */
  repeatPerExtraEvent: 8,
  repeatCap: 24,
  seniority: {
    founder_exec: 14,
    leader: 10,
    /** A recruiter is worth talking to; at a careers fair they are the whole point. */
    recruiter: 12,
    recruiterAtCareerFair: 18,
    ic: 0,
    unknown: 0,
  },
  schoolOverlap: 10,
  /**
   * Someone you know slightly, or have not spoken to in months. An event is the cheapest
   * possible excuse to fix that, and it is the most commonly missed opportunity in the room.
   */
  weakTie: 12,
  /**
   * Someone you speak to constantly. Not a penalty on THEM — a statement that you do not need
   * a conference to reach them, and the ten minutes is better spent elsewhere.
   */
  strongTiePenalty: -10,
  /** You already know somebody at their company, so there is a way in. */
  warmPath: 6,
  /** Hosts and speakers are easy to place and usually worth meeting. */
  hostOrSpeaker: 10,
  /** Already connected from THIS event: the user has dealt with them. */
  alreadyConnectedHere: -40,
} as const;

export type RelevanceReason = {
  code: string;
  label: string;
  points: number;
};

export type RelevanceBucket = "must" | "good" | "maybe" | "skip";

export type RelevanceInput = {
  fullName: string | null;
  company: string | null;
  title: string | null;
  attendeeRole: "attendee" | "host" | "speaker" | null;
  /** Already connected to a contact from this event. */
  connectedHere: boolean;
  /** Company keys (`companyMatchKeys`) for their employer. */
  companyKeys: string[];
  /** The user's targets, keyed the same way. */
  targetKeys: Map<string, number>;
  /** 0..1 from `goalRelevanceComponent`. */
  goalFit: number;
  /** How many events they have already shared with the user, this one included. */
  eventsTogether: number;
  /** Set when this roster row resolves to somebody already in the network. */
  network?: {
    contactId: string;
    closenessTier: "inner" | "mid" | "outer" | null;
    lastInteractionAt: Date | null;
    schools: string[];
  } | null;
  /** Contacts the user already has at this person's employer. */
  knownAtCompany: number;
  userSchools: string[];
  eventKind: EventKind | null;
  now?: Date;
};

export type RelevanceResult = {
  score: number;
  bucket: RelevanceBucket;
  reasons: RelevanceReason[];
};

const FOUNDER_EXEC =
  /\b(founder|co-?founder|ceo|cto|coo|cfo|cpo|cmo|chief|president|partner|managing director|owner)\b/i;
const LEADER = /\b(head of|vp|vice president|director|principal|lead|manager|staff)\b/i;
const RECRUITER =
  /\b(recruit(?:er|ing)|talent|sourcer|people ops|hr|human resources|campus|university relations|hiring)\b/i;

export type Seniority = keyof typeof RELEVANCE_WEIGHTS.seniority;

/**
 * What a job title says about why this person is worth meeting.
 *
 * Recruiter is checked FIRST: "Technical Recruiting Lead" is a recruiter, and reading it as a
 * "lead" would file the single most useful person at a careers fair under a generic rung.
 */
export function seniorityOf(title: string | null | undefined): Seniority {
  const value = title?.trim();
  if (!value) return "unknown";
  if (RECRUITER.test(value)) return "recruiter";
  if (FOUNDER_EXEC.test(value)) return "founder_exec";
  if (LEADER.test(value)) return "leader";
  return "ic";
}

/** Months since the last interaction, or null when there has never been one. */
function monthsSince(date: Date | null | undefined, now: Date): number | null {
  if (!date) return null;
  return (now.getTime() - date.getTime()) / (30 * 86_400_000);
}

/** Words that carry no identity in a school's name. */
const SCHOOL_NOISE = /\b(the|of|at|and|for|a)\b/g;

/**
 * The forms one school might be written in.
 *
 * Two, because people write both: "University of North Carolina" on a LinkedIn profile and
 * "UNC" in conversation. Matching only the long form would miss the case this signal is most
 * often useful in — a roster row that says "MIT" against a contact who wrote it out.
 *
 * The acronym is built from the full name INCLUDING "University", because that is where the
 * U in UNC comes from.
 */
function schoolKeys(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const words = cleaned.replace(SCHOOL_NOISE, " ").split(/\s+/).filter(Boolean);
  const keys = new Set<string>();
  // The whole name, minus the filler that varies between spellings.
  if (words.length > 0) keys.add(words.join(" "));
  // The acronym, when there is more than one significant word — "mit", "unc", "nyu".
  if (words.length > 1) keys.add(words.map((word) => word[0]).join(""));
  // A short form as written ("unc") is already its own key.
  if (words.length === 1) keys.add(words[0]!);
  return [...keys];
}

function sharesSchool(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const left = new Set(a.flatMap(schoolKeys));
  return b.flatMap(schoolKeys).some((key) => left.has(key));
}

export function scoreAttendee(input: RelevanceInput): RelevanceResult {
  const now = input.now ?? new Date();
  const reasons: RelevanceReason[] = [];
  const add = (code: string, label: string, points: number) => {
    if (points === 0) return;
    reasons.push({ code, label, points });
  };

  // A company the user is trying to get into.
  let targetPriority: number | null = null;
  for (const key of input.companyKeys) {
    const priority = input.targetKeys.get(key);
    if (priority !== undefined && (targetPriority === null || priority < targetPriority)) {
      targetPriority = priority;
    }
  }
  if (targetPriority !== null) {
    const points =
      RELEVANCE_WEIGHTS.targetCompany[
        targetPriority as keyof typeof RELEVANCE_WEIGHTS.targetCompany
      ] ?? RELEVANCE_WEIGHTS.targetCompany[3];
    add(
      "target_company",
      input.company ? `Works at ${input.company}, on your target list` : "On your target list",
      points
    );
  }

  if (input.goalFit > 0) {
    add(
      "goal_match",
      "Matches what you said you're working on",
      Math.round(RELEVANCE_WEIGHTS.goalMatch * Math.min(1, input.goalFit))
    );
  }

  const extraEvents = Math.max(0, input.eventsTogether - 1);
  if (extraEvents > 0) {
    add(
      "repeat",
      `You've been at ${input.eventsTogether} events with them`,
      Math.min(RELEVANCE_WEIGHTS.repeatCap, extraEvents * RELEVANCE_WEIGHTS.repeatPerExtraEvent)
    );
  }

  const seniority = seniorityOf(input.title);
  if (seniority === "recruiter" && input.eventKind === "career_fair") {
    add("recruiter_fair", "Recruiting at a careers fair", RELEVANCE_WEIGHTS.seniority.recruiterAtCareerFair);
  } else if (RELEVANCE_WEIGHTS.seniority[seniority] > 0) {
    const label =
      seniority === "recruiter"
        ? "Recruits for their company"
        : seniority === "founder_exec"
          ? "Runs their company"
          : "Leads a team";
    add(`seniority_${seniority}`, label, RELEVANCE_WEIGHTS.seniority[seniority]);
  }

  if (input.attendeeRole === "host" || input.attendeeRole === "speaker") {
    add(
      "host_or_speaker",
      input.attendeeRole === "host" ? "Hosting this event" : "Speaking here",
      RELEVANCE_WEIGHTS.hostOrSpeaker
    );
  }

  if (input.network) {
    const months = monthsSince(input.network.lastInteractionAt, now);
    const tier = input.network.closenessTier;
    if (tier === "inner" && months !== null && months < 2) {
      // Not a slight: you do not need a conference to reach them.
      add("strong_tie", "You already speak often", RELEVANCE_WEIGHTS.strongTiePenalty);
    } else if (tier === "outer" || months === null || months >= 4) {
      add(
        "weak_tie",
        months === null ? "In your network, never followed up" : "You haven't spoken in a while",
        RELEVANCE_WEIGHTS.weakTie
      );
    }
    if (sharesSchool(input.userSchools, input.network.schools)) {
      add("school", "You went to the same school", RELEVANCE_WEIGHTS.schoolOverlap);
    }
  } else if (input.knownAtCompany > 0) {
    // Only for strangers: a warm path matters because you have no other way in.
    add(
      "warm_path",
      `You know ${input.knownAtCompany} ${input.knownAtCompany === 1 ? "person" : "people"} at ${input.company ?? "their company"}`,
      RELEVANCE_WEIGHTS.warmPath
    );
  }

  if (input.connectedHere) {
    add("already_connected", "You've already connected from this event", RELEVANCE_WEIGHTS.alreadyConnectedHere);
  }

  const raw = reasons.reduce((total, reason) => total + reason.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  reasons.sort((a, b) => b.points - a.points);

  return {
    score,
    bucket: score >= 40 ? "must" : score >= 22 ? "good" : score >= 10 ? "maybe" : "skip",
    reasons,
  };
}
