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

/* ------------------------------------------------------------------ calendar ---------- */

/**
 * What a calendar event is. Only the first two are relationship touches — they create
 * contacts, log a meeting and (for ICS) schedule a follow-up. Counts, duration and dates are
 * computed in code and passed as fields; Jev reads text, not arithmetic.
 */
export const CALENDAR_KINDS = {
  one_on_one: "A one-to-one meeting with one other person the user knows or is getting to know",
  networking: "A small intro, coffee, or networking conversation with a few people",
  internal_team: "A work-internal meeting: a sync, standup, planning, review, or an interview the user conducts",
  personal_block: "A personal appointment or block: doctor, dentist, gym, travel, focus time, errands, a vendor or service appointment",
  invite: "A public or large event: a talk, party, webinar, conference or meetup invitation",
  other: "Anything else",
} as const;

export const calendarKindQuestion = choice(
  "What kind of calendar entry is `event`?",
  CALENDAR_KINDS,
);

export const CALENDAR_TUNING = {
  /**
   * START. A rule "keep" is SKIPPED when Jev's probability that the event is a one-to-one
   * or networking touch is at or below this — no contact, no fake meeting, no follow-up.
   * Skipping is the direction today's rules already take silently for most events.
   */
  skipAtOrBelow: 0.2,
  /**
   * Keeping an event the rules skip creates contacts nobody asked for. DISABLED until the
   * calibration bins clear the bar; while off, rule-skipped events are not even asked about.
   */
  act: null as number | null,
  /**
   * Events per call. Measured Sep 22 2026 (`calendar` eval): the other events in a call act
   * as distractors — the same customer-onboarding call scored 0.10 in one batch and escaped
   * the veto in another. 3 matched 1 and 6 on accuracy (90.6%) with fewer requests than 1.
   */
  chunkSize: 3,
  concurrency: 3,
  /** Background sync: a page of events at most. */
  budgetMs: 6_000,
  /** ICS feeds re-read a 150-day window every 30 minutes; an event is judged once. */
  cacheDays: 90,
  descriptionChars: 500,
} as const;

/* ------------------------------------------------------------------ capture: checks --- */

/** Per extracted person, over the note: were they in the conversation, only named, or neither? */
export function presenceQuestion(key: string) {
  return choice(`In \`note\`, what is the person named \`people.${key}\`?`, {
    participant: "Someone the user met, spoke with, or was in the conversation with",
    mentioned: "Someone only talked ABOUT: named or referred to, but not part of the conversation",
    not_in_note: "Not in the note at all — nobody by that name or description appears",
  });
}

/** Per tag the model proposed: one of the account's existing tags, or genuinely new. */
export function tagMatchQuestion(key: string, existing: Record<string, string>): ChoiceQuestion<string> {
  return choice<string>(`Which of the user's existing tags means the same as \`proposed.${key}\`?`, {
    ...existing,
    keep_new: "None of them means the same thing — it is a new tag",
  });
}

/** Per opportunity the referral LANGUAGE test relabelled, over its own sentence. */
export function referralQuestion(key: string) {
  return noul(
    `In \`offers.${key}.sentence\`, is someone offering to put the user's name forward for a role, or to refer the user to someone hiring?`,
    {
      true: "An offer to refer, recommend, vouch for, or pass on the user's name for a job.",
      false: "A refusal (\"they don't do referrals\"), advice, a recommendation of something other than the user (a book, a tool), or a general mention of referrals.",
    },
  );
}

export const CAPTURE_CHECK_TUNING = {
  /**
   * Dropping an invented person, or flipping participant/mentioned against the model, with
   * no review of that decision. DISABLED until the calibration bins clear the bar.
   */
  presenceAct: null as number | null,
  /** START. A proposed tag is written as the existing one when Jev's pick clears this. */
  tagPickAbove: 0.6,
  /** START. The language test's "referral" is reverted to the model's kind below this. */
  referralVetoBelow: 0.3,
  /** Existing tags offered per proposed tag (a choice takes at most 255 options). */
  maxExistingTags: 200,
  noteChars: 12_000,
  budgetMs: 1_500,
} as const;

/* ------------------------------------------------------------------ skip-gates -------- */

/**
 * "Is there anything here?" before a chat-model call whose answer is usually "nothing".
 * Jev only: without a TypeSafe key every one of these calls runs exactly as before — the
 * gate's whole point is to skip the model, so there is no model to fall back to.
 *
 * Each question asks about the INPUT's own words; a confident "no" skips the call and the
 * step returns what it returns for an empty answer today.
 */
export const SKIP_GATES = {
  dates: noul(
    "Does `notes` state a date, deadline or time frame for something to happen, or a rhythm for staying in touch?",
    {
      true: "A meeting next Tuesday, a deadline, \"follow up in two weeks\", \"after the holidays\", \"check in monthly\".",
      false: "No date, deadline, time frame or rhythm is stated for anything.",
    },
  ),
  brief: noul(
    "Does `new_input` contain anything `current_brief` does not already reflect — a newer interaction, a changed role or company, a new or closed opportunity or commitment?",
    {
      true: "Something in the input is newer than, or contradicts, what the brief says.",
      false: "Everything in the input is already reflected in the brief.",
    },
  ),
  starters: noul(
    "Does `material` contain something specific about this person that an opening line could refer to — a shared interest, a recent post or role change, a mutual connection, or a concrete detail from the user's notes?",
    {
      true: "At least one concrete, person-specific detail.",
      false: "Only generic facts: a name, a title, a company, a location.",
    },
  ),
  enrich: noul(
    "Is `messages` a real conversation with substance, beyond a connection-request note, a single greeting or automated text?",
    {
      true: "Back-and-forth, or at least one message with a real ask, update or detail.",
      false: "Only boilerplate: \"I'd like to join your network\", \"thanks for connecting\", one-line pleasantries.",
    },
  ),
  timeline: noul(
    "Do `messages` propose, schedule or confirm a meeting, a call or an in-person get-together?",
    {
      true: "\"Let's grab coffee Thursday\", \"sent you an invite\", \"great meeting you at the conference\", \"call at 3?\".",
      false: "No meeting, call or get-together is proposed, scheduled or confirmed.",
    },
  ),
} as const;

export const SKIP_GATE_TUNING = {
  /**
   * The call is skipped at or below this probability that there is something here. `null`
   * turns a gate off: it is never asked and the call always runs.
   *
   * TUNED on `ai-skip-gates-eval.json`, two runs (docs/ai-evals/2026-09-22-*-jev). Each
   * number sits in the gap that gate's own cases opened, on the safe side of the middle,
   * and run-to-run drift across those two runs was at most 0.04:
   *
   *   dates     nothing-here ≤ 0.17, something-here ≥ 0.94  → 0.40
   *   starters  nothing-here ≤ 0.29, something-here ≥ 0.94  → 0.45
   *   enrich    nothing-here ≤ 0.46, something-here ≥ 0.87  → 0.35 (a mass InMail reads
   *             as substance at 0.46, so it is asked about rather than risk the gap)
   *   timeline  nothing-here ≤ 0.02, something-here ≥ 0.39  → 0.15 ("great meeting you at
   *             SaaStr" is a real meeting and only scores 0.39, so this one stays low)
   *
   *   brief     OFF. Measured and it does not work: "the input changed but the
   *             relationship did not" scored 0.45–0.96, overlapping the cases that had
   *             genuinely changed (0.96–0.98). Diffing a long input against a prose brief
   *             is past what a decision model can do, and the wrong-skip cost — a brief
   *             that quietly stops updating — is high. The wiring and the fixture cases
   *             stay so a later model version can be re-measured by flipping this number.
   */
  skipAtOrBelow: { dates: 0.4, brief: null, starters: 0.45, enrich: 0.35, timeline: 0.15 } as Record<
    keyof typeof SKIP_GATES,
    number | null
  >,
  /** In front of a call the person may be waiting on; past this the call just runs. */
  budgetMs: 1_200,
  /** Background paths gate a whole slice at once, this many in flight. */
  concurrency: 4,
  /**
   * The state IS the input text, so an identical input has an identical answer. Worth
   * caching because several paths ask twice about one thing: a calendar feed re-read every
   * half hour, a brief the page asks for on each visit, and a batch that falls back to the
   * inline path after its queue was already gated.
   */
  cacheDays: 30,
  inputChars: 12_000,
} as const;
