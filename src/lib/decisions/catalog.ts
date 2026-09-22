import { noul, score } from "@/lib/decisions/jev";

/**
 * Every question Orbit asks the decision model, and every threshold it acts on.
 *
 * One file because they are one thing: a threshold means something only against the words
 * of its question and the model version that answered (`JEV_MODEL` in ai-models.ts). Change
 * any of the three and the eval (`scripts/eval-ai.ts --decisions jev`) runs again before it
 * ships — the calibration bins in its report are what these numbers are read off.
 *
 * Writing a question (TypeSafe's own guidance, which matched what the eval showed):
 *  - one judgment per question; a compound condition is two questions
 *  - criteria describe SITUATIONS ("a hiring manager writing about a role"), not degrees
 *  - never ask it to count, compare dates or do arithmetic — do that in code
 *  - send only the fields the question needs; unrelated state measurably lowers accuracy
 *  - it reads literally: say what you mean, including the boundary cases
 *
 * Thresholds marked START are the values the feature shipped with before a tuned eval run.
 */

/* ------------------------------------------------------------------ recruiters ------- */

/**
 * The same definition `RECRUITER_SYSTEM` gives the LLM (recruiter-scan.ts), so the two
 * engines are judging one thing. Hiring managers count: the eval fixture has three, and the
 * keyword prefilter missed all of them.
 */
const RECRUITER_CRITERIA = {
  true:
    "Someone whose role in this mail is hiring or sourcing candidates: an in-house recruiter or talent-acquisition partner, an agency recruiter, a headhunter, a sourcer, or a hiring manager writing personally about a specific opening or about the recipient as a candidate.",
  false:
    "Job-board alerts and job newsletters (LinkedIn Jobs, Indeed, Otta, Hired), automated applicant-tracking notifications (application received, interview booked by a system), colleagues, friends, mentors, vendors, sales outreach, and anyone who only mentions jobs or hiring in passing.",
};

/**
 * PREFILTER — before any message body is fetched, on the From line, subject and snippet
 * alone. Asked only where the keyword prefilter (`looksLikeRecruiter`) said no, to win back
 * the recruiters it misses; a keyword yes stays a yes. One question per sender, filed under
 * `messages.<key>` so several senders can share a call.
 */
export function recruiterPrefilterQuestion(key: string) {
  return noul(
    `Is the sender of \`messages.${key}\` reaching out to the recipient about hiring them or about a job opening?`,
    RECRUITER_CRITERIA,
  );
}

/**
 * GATE — before the recruiter LLM call, on the same messages the LLM would read. A sender
 * Jev is confident is NOT a recruiter skips the LLM. Everything else goes to the LLM as
 * before: positives still need it for the summary, firm and roles.
 */
export const recruiterGateQuestions = {
  recruiter: noul(
    "Is the sender described in `sender` a recruiter, judging from their `messages` to the recipient?",
    RECRUITER_CRITERIA,
  ),
};

export const RECRUITER_TUNING = {
  /**
   * START. Recall-biased on purpose: a false negative here is a recruiter the user never
   * sees ("invisible forever", gmail.ts), while a false positive costs one gate question and
   * at worst one LLM call that says no.
   */
  prefilterAdmit: 0.3,
  /**
   * START. At or below this, the sender is ruled out without the LLM. Low, because a wrong
   * rejection loses a recruiter and a wrong pass only costs the call we made before Jev.
   */
  gateReject: 0.1,
  /** START. Senders per prefilter call — header lines are short, so several share one. */
  prefilterChunkSize: 8,
  /**
   * Calls in flight per scan. TypeSafe allows 1,200 requests a minute per account, and at
   * ~150ms a call three workers stay under it; a 429 still just means "no answer".
   */
  concurrency: 3,
  /** Background work: generous, but a hung call must not eat the invocation's budget. */
  timeoutMs: 8_000,
  /** Same as the LLM verdict cache: a re-scan re-reads mail it already judged. */
  cacheDays: 90,
} as const;

/* ------------------------------------------------------------------ chat rerank ------ */

/**
 * Four levels, each a situation rather than a degree. The LLM rerank's 0–10 scale kept
 * anything scored 3 or more; the equivalent line here is level 1, "shares a surface detail".
 */
export const RERANK_LEVELS = [
  "Unrelated to what the question asks for",
  "Shares a surface detail with the question (the same company, place, school or field) but is not what it asks for",
  "Plausibly useful for what the question asks for",
  "Directly what the question asks for",
] as const;

export function rerankQuestion(candidateKey: string) {
  return score(
    `How well does the contact in \`candidates.${candidateKey}\` match what \`question\` asks for? Judge only from that contact's card.`,
    RERANK_LEVELS,
  );
}

export const RERANK_TUNING = {
  /** START. Normalized score (0–1) a candidate needs to be kept: just under level 1 of 3. */
  keepMin: 0.3,
  /**
   * START. Added to a candidate that matched the user's explicit filters. It replaces the
   * LLM prompt's "prefer matches_filters=yes when relevance is comparable" — a rule is
   * code's job, and Jev reads such instructions literally.
   */
  filterBonus: 0.1,
  /**
   * START. Candidates per call. Every question in a call reads the whole state, so one call
   * for all 60 is cheapest but makes 59 cards distractors for each question; the Phase 0
   * spike picks this from measured billing and recall.
   */
  chunkSize: 15,
  /** Jev answers in ~100–500ms; past this the LLM rerank runs instead. */
  timeoutMs: 1500,
} as const;
