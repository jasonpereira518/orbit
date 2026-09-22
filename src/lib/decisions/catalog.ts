import { choice, noul, score, type ChoiceQuestion } from "@/lib/decisions/jev";

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

/* ------------------------------------------------------------------ chat routing ----- */

/**
 * The routing questions every chat question is asked, in ONE call over `{question,
 * prior_turns}` (state billed once). They replace keyword rules that each had documented
 * misses: `chooseDepth` (chat-depth.ts) sent "who should I talk to about X" to a research
 * round, `isAttentionQuestion` fired on "Who should I ask?" and "cold email", and
 * `isRecruiterIntent` missed "recruitment" and "head hunter".
 *
 * Depth is four yes/no questions, not one five-way pick: the first eval run asked a single
 * `choice` and it blurred them — attention-style questions ("which relationships are going
 * cold?") landed on "what was said". One judgment per question, as TypeSafe advises.
 */
export const DEPTH_REASONS = {
  said: "asks what was said",
  path: "asks for a path to someone",
  period: "asks about a time",
  followUp: "follows up on the last answer",
} as const;

export type DepthReason = keyof typeof DEPTH_REASONS;

export const chatRouteQuestions = {
  // Each asks about the QUESTION's own words, never about data Jev cannot see: the first
  // wording ("is the answer in the user's notes?") was indirect, and Jev read it literally.
  said: noul(
    "Does `question` ask what someone said, discussed, promised, asked for, advised, thought or wrote — or what the user's notes say?",
    {
      true: "\"What did Priya say about…\", \"what did I promise…\", \"what feedback did…\", \"summarize my notes on…\", \"did anyone recommend…\".",
      false: "Asks who someone is, where they work, who fits a description or has some expertise, who needs a follow-up, or asks to write a new message.",
    },
  ),
  path: noul(
    "Does `question` ask for an introduction to, or a way in to, a specific person or organisation the user does not already know?",
    {
      true: "\"Who can introduce me to…\", \"a warm path to…\", \"who could connect me with…\", \"who knows someone at…\", \"who could vouch for me at…\".",
      false: "Finding people the user already knows who fit a description, work somewhere, or have some expertise — even if the user then plans to contact them.",
    },
  ),
  period: noul(
    "Does `question` ask about a specific past date or time period?",
    {
      true: "A named month or season, last week, last month, last year, \"when did…\", \"how long ago…\".",
      false: "No time at all, \"this week\", \"lately\", \"in a while\", \"recently\", or a cohort or batch name.",
    },
  ),
  followUp: noul(
    "Does `question` refer back to people or answers in `prior_turns` (a pronoun, \"the second one\", \"them\")?",
    {
      true: "It cannot be understood without the earlier turns.",
      false: "It stands on its own, even if it continues the same topic.",
    },
  ),
  attention: noul(
    "Is `question` asking which people across the user's network to reconnect or follow up with, or who has gone quiet or is overdue for contact?",
    {
      true: "Asks for people to reach out to, reconnect with, follow up with, or who the user has lost touch with or is neglecting, across the network.",
      false: "Asks about one named person or one organisation, asks to draft a message, asks who knows about a topic, or asks who the user met or caught up with in the past.",
    },
  ),
  recruiters: noul(
    "Is `question` asking for recruiters, headhunters or talent-acquisition people themselves?",
    {
      true: "Wants recruiters, headhunters, sourcers, recruiting agencies or talent-acquisition partners the user knows.",
      false: "Asks about people at a company who are hiring, a company's own hiring, hiring managers, or general hiring advice.",
    },
  ),
};

/** One per organisation `findOrgRosters` matched, over `{question, orgs}`. */
export function rosterQuestion(key: string) {
  return noul(
    `Would the list of everyone the user knows at the organisation in \`orgs.${key}\` help answer \`question\`?`,
    {
      true: "The question is about that organisation: its people, its teams, its hiring, or reaching someone there.",
      false: "The name only appears as an ordinary word (\"ramp up\", \"a notion of\", \"square this\", \"the block editor\"), or as someone's past employer mentioned in passing.",
    },
  );
}

export const CHAT_ROUTE_TUNING = {
  /** START. Research runs when any depth question's probability reaches this. */
  researchAbove: 0.5,
  /**
   * START. The attention brief carries an imperative prompt rule ("answer from it"), so it is
   * precision-biased; the always-on attention line still covers a missed one.
   */
  attentionAbove: 0.6,
  /** START. */
  recruitersAbove: 0.5,
  /** START. A roster is attached (with its "authoritative" rule) only above this. */
  rosterAbove: 0.5,
  /** Runs beside retrieval, which takes 1–5s; this is a ceiling, not a cost. */
  timeoutMs: 1_200,
  /** Prior turns in the state: the last two, trimmed. */
  priorTurns: 2,
  priorTurnChars: 400,
} as const;

/* ------------------------------------------------------------------ duplicates ------- */

/**
 * "Same person?" over two contact cards. Asked only where the matcher's evidence is a NAME
 * (same name + company or title, a fuzzy name, a bare shared name). Identifier matches — a
 * shared email, LinkedIn or X handle — stay rule-only: they are facts, not judgements.
 */
export function samePersonQuestion(key: string) {
  return noul(
    `Are \`pairs.${key}.a\` and \`pairs.${key}.b\` the same person?`,
    {
      true: "The same individual: the same name or an obvious nickname or short form, and nothing that contradicts it. A job change, a new title or a missing field is normal for one person.",
      false: "Two different people who share or resemble a name: different employers or roles held at the same time, different schools or cities, or other facts that cannot both be true of one person.",
    },
  );
}

export const DUPLICATE_TUNING = {
  jev: {
    /**
     * At or below this, an automatic merge or fold on name evidence is VETOED: the two are
     * kept apart and the pair goes to the review queue instead.
     *
     * Tuned Sep 22 2026 (`duplicates` eval, 45 pairs, jev-1.13.0, two runs): every
     * different-people pair scored ≤ 0.59 and every same-person pair ≥ 0.81. The START value
     * (0.15) vetoed 2 of the 13 wrong merges the rules make; 0.7 sits mid-gap — ~0.1 of
     * margin either side for Jev's run-to-run drift — vetoes all 13 and loses no real one.
     * A wrong veto costs one review click; a wrong merge silently collapses two people.
     */
    rejectAtOrBelow: 0.7,
    /**
     * Auto-merge of a bare shared-name pair (0.60, which today always waits for a person).
     * DISABLED until the calibration bins show precision 1.0 on n ≥ 20 at the threshold.
     */
    act: null as number | null,
  },
  /** Pairs per call. Cards are small, so several share a state. */
  chunkSize: 5,
  concurrency: 3,
  /** The sweep runs during the duplicates page render. */
  sweepBudgetMs: 800,
  /** A single in-request resolve (new-contact form, promoting a set-aside person). */
  resolveBudgetMs: 700,
  /** Background imports, sync and capture saves. */
  backgroundBudgetMs: 4_000,
  /** Ranking the review queue on render: Jev, or the person's own model (cached per pair). */
  reviewBudgetMs: 2_500,
  reviewMaxPairs: 40,
  cacheDays: 30,
} as const;

/* ------------------------------------------------------------------ capture: who ------ */

/**
 * Which existing contact a name in a note refers to. Options are the candidate contacts,
 * each described by name, title and company, plus "none". State: the sentence from the NOTE
 * (never the model's paraphrase of it), and the participant it sits beside.
 */
export function whichContactQuestion(options: Record<string, string>): ChoiceQuestion<string> {
  return choice<string>("Which contact does `mention` refer to, judging from `sentence`?", {
    ...options,
    none: "None of these: someone else with that name, or not enough to tell.",
  });
}

/** The same shape for a note's participant: an existing contact, or a new person. */
export function mergeTargetQuestion(options: Record<string, string>): ChoiceQuestion<string> {
  return choice<string>("Is `person` one of these existing contacts?", {
    ...options,
    new: "None of them: a different person who is not in the user's contacts yet.",
  });
}

export const MENTION_TUNING = {
  /**
   * START. The rules link a one-word mention to the only contact with that first name, at
   * 0.7, blind ("Sam" → your one Sam, whoever the note meant). An engine answer below this
   * for that contact UN-links it — the mention is offered as a new person instead. Vetoing
   * a guess is not acting, so the person's own model may do it too.
   */
  vetoBelow: 0.3,
  /**
   * Linking a mention the rules left ambiguous, with no one to review it (mentions are saved
   * with the note). DISABLED until the calibration bins clear the bar. Jev only.
   */
  act: null as number | null,
  /** Candidates offered per mention. */
  maxCandidates: 8,
  /** Jev ~200ms; the person's own model gets the rest (it runs after the parse). */
  budgetMs: 2_000,
  jevMs: 800,
  sentenceChars: 400,
} as const;

export const MERGE_TARGET_TUNING = {
  /**
   * START. The review card's DEFAULT only — the person still confirms every card. Today a
   * bare 0.6 name match defaults to "update existing"; with Jev the default follows its pick
   * when the pick clears this, including "a new person".
   */
  pickAbove: 0.6,
  budgetMs: 1_500,
} as const;
