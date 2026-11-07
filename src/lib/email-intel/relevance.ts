/**
 * Who in the user's network is worth reaching for an email event.
 *
 * The same contract as `scoreAttendee` (`src/lib/events/relevance.ts`), and for the same
 * reasons. EXPLAINABLE: every point carries a reason, because "talk to Dana" is useless and
 * "Recruits for Northwind, on your target list, and is on this thread" is something a person
 * can act on. STABLE: same inputs, same order, which a model cannot promise. The optional AI
 * step, if one is ever added, writes prose about a row this has already chosen.
 *
 * Seniority is a weak, biased signal and is weighted as one. It counts only where it predicts
 * usefulness: a recruiter for a job event, a leader for company news, and only for people who
 * are at the company or on the thread. A recruiter somewhere else is not a route to this job.
 *
 * Pure: no network, no database, no AI. The caller loads the facts.
 */
import { seniorityOf, type RelevanceReason } from "@/lib/events/relevance";
import type { EmailEventKind } from "./types";

/**
 * Every weight in one object, because they only make sense relative to each other. Exported
 * so the smoke asserts ORDERINGS rather than re-typing the numbers.
 */
export const EMAIL_RELEVANCE_WEIGHTS = {
  /** They are on the email. The strongest single signal: the conversation is already open. */
  onThread: 30,
  /** They work at the company the email is about. */
  sameCompany: 20,
  /** Added to `sameCompany` when the company is on the user's target list, by priority. */
  targetCompany: { 1: 15, 2: 10, 3: 5 },
  /** For a job or a hiring-process event: who can actually move it. */
  seniority: { recruiter: 14, leader: 10, founder_exec: 8, ic: 0, unknown: 0 },
  /** For company news or an event: who is senior enough to have a view. A recruiter is not. */
  seniorityForNews: { recruiter: 0, leader: 6, founder_exec: 6, ic: 0, unknown: 0 },
  /** The title shares a word with the role, or several. */
  roleMatchOne: 10,
  roleMatchMany: 14,
  /** Scaled by `goalRelevanceComponent`, already 0..1. */
  goalMatch: 15,
  /** How well they know the user. Closer is a warmer route. */
  closeness: { inner: 10, mid: 6, outer: 0 },
  /** Found only because their profile mentions the role's words; scaled by the search score. */
  searchMatch: 12,
} as const;

export type EmailRelevanceBucket = "must" | "good" | "maybe" | "skip";

export type EmailRelevanceInput = {
  eventKind: Exclude<EmailEventKind, "other">;
  eventCompany: string | null;
  /** `companyMatchKeys(event.company)`. */
  eventCompanyKeys: string[];
  eventRole: string | null;
  candidate: {
    contactId: string;
    fullName: string;
    company: string | null;
    title: string | null;
    /** `companyMatchKeys(candidate.company)`. */
    companyKeys: string[];
    closenessTier: "inner" | "mid" | "outer" | null;
  };
  via: {
    /** On the email (named by the model, or on its headers). */
    thread: boolean;
    /** Returned by the lexical profile search. */
    search: boolean;
    /** The search's own 0..1 relevance. Ignored unless `search`. */
    searchRelevance: number;
  };
  /** The user's target companies, keyed like `companyMatchKeys`, valued by priority 1..3. */
  targetKeys: Map<string, number>;
  /** 0..1 from `goalRelevanceComponent`. */
  goalFit: number;
};

export type EmailRelevanceResult = {
  score: number;
  bucket: EmailRelevanceBucket;
  reasons: RelevanceReason[];
};

/** Words that say how senior a role is, or connect other words, and so say nothing about what it is. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "of", "at", "in", "to", "an",
  "senior", "staff", "principal", "lead", "junior", "associate", "intern",
  "sr", "jr", "head", "chief", "vice", "president", "vp", "director",
]);

/** The meaningful lowercase words of a role or title, in order, without repeats. */
export function significantWords(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const word of (text ?? "").toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (word.length < 3 || STOP_WORDS.has(word) || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/**
 * A deliberately crude stem: enough that "engineer", "engineers" and "engineering" compare
 * equal and "payment" matches "payments". Two passes because "engineering" → "engineer" →
 * "engine". It will not unify "analyst" with "analytics"; a miss costs a few points, and a
 * false match is worse, so it stays this simple.
 */
export function stemOf(word: string): string {
  let stem = word;
  for (let pass = 0; pass < 2; pass++) {
    if (stem.length > 4) stem = stem.replace(/(ing|ers|er|s)$/, "");
  }
  return stem;
}

function bucketOf(score: number): EmailRelevanceBucket {
  return score >= 40 ? "must" : score >= 22 ? "good" : score >= 10 ? "maybe" : "skip";
}

export function scoreEmailContact(input: EmailRelevanceInput): EmailRelevanceResult {
  const W = EMAIL_RELEVANCE_WEIGHTS;
  const reasons: RelevanceReason[] = [];
  const add = (code: string, label: string, points: number) => {
    if (points !== 0) reasons.push({ code, label, points });
  };
  const c = input.candidate;
  const sameCompany = c.companyKeys.some((key) => input.eventCompanyKeys.includes(key));
  const companyName = c.company ?? input.eventCompany ?? "their company";

  if (input.via.thread) add("on_thread", "On this email thread", W.onThread);

  if (sameCompany) {
    add("same_company", `Works at ${companyName}`, W.sameCompany);
    let priority: number | null = null;
    for (const key of input.eventCompanyKeys) {
      const p = input.targetKeys.get(key);
      if (p !== undefined && (priority === null || p < priority)) priority = p;
    }
    if (priority !== null) {
      const table = W.targetCompany;
      add("target_company", `${companyName} is on your target list`, table[priority as keyof typeof table] ?? table[3]);
    }
  }

  if (input.via.thread || sameCompany) {
    // `seniorityOf` is typed over the events feature's weight keys, which include a careers-fair
    // variant it never returns; it is a recruiter here.
    const raw = seniorityOf(c.title);
    const seniority: "recruiter" | "leader" | "founder_exec" | "ic" | "unknown" =
      raw === "recruiterAtCareerFair" ? "recruiter" : raw;
    const table = input.eventKind === "news" || input.eventKind === "event" ? W.seniorityForNews : W.seniority;
    const label =
      seniority === "recruiter"
        ? "Recruits for their company"
        : seniority === "founder_exec"
          ? "Runs their company"
          : "Leads a team";
    add(`seniority_${seniority}`, label, table[seniority]);
  }

  const roleStems = new Map(significantWords(input.eventRole).map((word) => [stemOf(word), word]));
  if (roleStems.size > 0 && c.title) {
    const shared = significantWords(c.title)
      .map((word) => roleStems.get(stemOf(word)))
      .filter((word): word is string => Boolean(word));
    if (shared.length > 0) {
      add(
        "role_match",
        `Title matches the role (${shared.join(", ")})`,
        shared.length > 1 ? W.roleMatchMany : W.roleMatchOne
      );
    }
  }

  if (input.goalFit > 0) {
    add("goal_match", "Matches what you said you're working on", Math.round(W.goalMatch * Math.min(1, input.goalFit)));
  }

  if (c.closenessTier) {
    add(
      `closeness_${c.closenessTier}`,
      c.closenessTier === "inner" ? "You know them well" : c.closenessTier === "mid" ? "You've met" : "In your network",
      W.closeness[c.closenessTier]
    );
  }

  if (input.via.search && !input.via.thread && !sameCompany) {
    add("search_match", "Their profile matches the role", Math.round(W.searchMatch * Math.max(0, Math.min(1, input.via.searchRelevance))));
  }

  const raw = reasons.reduce((total, reason) => total + reason.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  reasons.sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
  return { score, bucket: bucketOf(score), reasons };
}
