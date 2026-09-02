/**
 * Pulls dated commitments and events out of captured note prose — absolute, relative
 * ("next Friday", "in two weeks"), and vague ("soon") alike.
 *
 * Design note: the prompt is only a filter. Everything that actually *guarantees*
 * correctness — verbatim containment, date resolution, and rejecting phrasing the
 * grammar can't handle — lives in `validateCommitments` below, in TypeScript, so the
 * behavior holds identically across all three AI providers. In particular the year is
 * always recomputed here and never trusted from the model, and relative/vague phrases
 * are resolved deterministically against the anchor, never guessed by the model.
 */

import { z } from "zod";
import { completeJson } from "@/lib/ai";
import { MONTHS, atLocalNoon } from "@/lib/interaction-date";
import { resolveRelativeDate, type DateBasis } from "@/lib/relative-date";
import {
  isReminderActionKind,
  inferReminderActionKind,
} from "@/lib/reminder-action-kind";
import type { ReminderActionKind } from "@/db/schema";

const MAX_COMMITMENTS = 25;
const MAX_NOTE_CHARS = 60_000;

export type DatedCommitment = {
  title: string;
  description: string | null;
  rawDatePhrase: string;
  /** Resolved date, pinned to local noon. */
  dueDate: Date;
  yearInferred: boolean;
  personName: string | null;
  actionKind: ReminderActionKind;
  /** 0-100. */
  confidenceScore: number;
  sourceExcerpt: string;
  dateBasis: DateBasis;
  anchorIso: string;
};

export type RejectedCounts = {
  relative: number;
  unverifiable: number;
  past: number;
};

export type DatedCommitmentResult = {
  commitments: DatedCommitment[];
  rejected: RejectedCounts;
};

export function emptyCommitmentResult(): DatedCommitmentResult {
  return { commitments: [], rejected: { relative: 0, unverifiable: 0, past: 0 } };
}

const nullTrimmed = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || null);

const commitmentItemSchema = z.object({
  title: z.string().min(1),
  detail: nullTrimmed,
  raw_date_phrase: z.string().min(1),
  date: z.string(),
  // Parsed but not trusted: the validator classifies the phrase itself.
  date_kind: nullTrimmed,
  year_stated: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  person_name: nullTrimmed,
  kind: nullTrimmed,
  confidence: z
    .number()
    .nullish()
    .transform((v) => (v == null || Number.isNaN(v) ? 0.5 : Math.min(1, Math.max(0, v)))),
  source_excerpt: z
    .string()
    .nullish()
    .transform((v) => v?.trim() || ""),
});

export type RawCommitmentItem = z.infer<typeof commitmentItemSchema>;

export const datedCommitmentsSchema = z.object({
  commitments: z
    .array(commitmentItemSchema)
    .nullish()
    .transform((v) => v ?? []),
});

/* ------------------------------------------------------------------ */
/* Date-shape recognition                                              */
/* ------------------------------------------------------------------ */

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length);
const MONTH_ALTERNATION = MONTH_NAMES.join("|");

/** "Sept 2", "September 2nd, 2026" */
const MONTH_FIRST_RE = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?\\b`,
  "i"
);
/** "2nd of September", "15th of October 2026" */
const DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALTERNATION})\\.?(?:,?\\s*(20\\d{2}))?\\b`,
  "i"
);
/** "2026-09-02" */
const ISO_RE = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/;
/** "9/2", "9/2/2026" — US month/day ordering, matching the rest of this codebase. */
const NUMERIC_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/;

/**
 * Classifies a phrase as relative; the grammar in relative-date.ts decides if it
 * resolves. Rejected even when a month name is also present ("next September"), because
 * the intent is ambiguous.
 */
const RELATIVE_RE =
  /\b(next|this|last|coming|following|upcoming|tomorrow|yesterday|today|soon|later|sometime|eod|eow|eom|q[1-4]|in\s+\d+\s+(day|week|month|year)s?|end\s+of\s+(the\s+)?(week|month|quarter|year))\b/i;

function normalizeForMatch(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

type MonthDay = { month: number; day: number; statedYear: number | null };

/**
 * Recovers month/day from the phrase itself. Returning null means the phrase does not
 * name an absolute calendar date, which is the rejection signal.
 */
export function deriveMonthDay(phrase: string): MonthDay | null {
  const iso = phrase.match(ISO_RE);
  if (iso) {
    return {
      month: Number(iso[2]) - 1,
      day: Number(iso[3]),
      statedYear: Number(iso[1]),
    };
  }

  const monthFirst = phrase.match(MONTH_FIRST_RE);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month != null) {
      return {
        month,
        day: Number(monthFirst[2]),
        statedYear: monthFirst[3] ? Number(monthFirst[3]) : null,
      };
    }
  }

  const dayFirst = phrase.match(DAY_FIRST_RE);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (month != null) {
      return {
        month,
        day: Number(dayFirst[1]),
        statedYear: dayFirst[3] ? Number(dayFirst[3]) : null,
      };
    }
  }

  const numeric = phrase.match(NUMERIC_RE);
  if (numeric) {
    return {
      month: Number(numeric[1]) - 1,
      day: Number(numeric[2]),
      statedYear: numeric[3] ? Number(numeric[3]) : null,
    };
  }

  return null;
}

function startOfDay(d: Date) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Resolves to a concrete date. When the note stated no year we take the nearest FUTURE
 * occurrence — the opposite of `parseInteractionDateFromNotes`, which assumes a past
 * interaction and walks the year backwards. Reusing that here would send "kickoff Jan 8"
 * captured in December into the year that just ended.
 */
function resolveDate(md: MonthDay, today: Date) {
  if (md.month < 0 || md.month > 11 || md.day < 1 || md.day > 31) return null;

  if (md.statedYear != null) {
    const d = new Date(md.statedYear, md.month, md.day, 12, 0, 0, 0);
    if (Number.isNaN(d.getTime()) || d.getMonth() !== md.month) return null;
    return { date: d, yearInferred: false };
  }

  const d = new Date(today.getFullYear(), md.month, md.day, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime()) || d.getMonth() !== md.month) return null;
  if (d < startOfDay(today)) {
    d.setFullYear(today.getFullYear() + 1);
  }
  return { date: d, yearInferred: true };
}

function toIsoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Validation — the layer that actually enforces "absolute dates only"  */
/* ------------------------------------------------------------------ */

export type ValidateOptions = { today: Date; anchor?: Date };

/**
 * Exported separately from the network call so it can be exercised without an API key.
 * See `scripts/smoke-date-commitments.ts`.
 */
export function validateCommitments(
  rawItems: RawCommitmentItem[],
  notes: string,
  opts: ValidateOptions
): DatedCommitmentResult {
  const today = opts.today;
  const anchor = atLocalNoon(opts.anchor ?? today);
  const anchorIso = toIsoDay(anchor);

  const rejected: RejectedCounts = { relative: 0, unverifiable: 0, past: 0 };
  const commitments: DatedCommitment[] = [];
  const seen = new Set<string>();

  const haystack = normalizeForMatch(notes);
  const todayStart = startOfDay(today);

  for (const item of rawItems) {
    const phrase = item.raw_date_phrase.trim();
    if (!phrase) {
      rejected.unverifiable += 1;
      continue;
    }

    // 1. The phrase must literally appear in the note. A hallucinated date almost never
    //    survives verbatim containment, which makes this the strongest guard we have.
    if (!haystack.includes(normalizeForMatch(phrase))) {
      rejected.unverifiable += 1;
      continue;
    }

    // 2. Relative phrasing resolves against the anchor through the deterministic grammar.
    //    Unknown relative phrasing is rejected — never guessed.
    let resolvedDate: Date;
    let yearInferred = false;
    let dateBasis: DateBasis;
    if (RELATIVE_RE.test(phrase) || !deriveMonthDay(phrase)) {
      const rel = resolveRelativeDate(phrase, anchor);
      if (!rel) {
        rejected.relative += 1;
        continue;
      }
      resolvedDate = rel.date;
      dateBasis = rel.basis;
    } else {
      // 3. Absolute: the phrase names a calendar date; the model's ISO must agree.
      const md = deriveMonthDay(phrase)!;
      const resolved = resolveDate(md, today);
      if (!resolved) {
        rejected.unverifiable += 1;
        continue;
      }
      const modelIso = item.date.trim();
      const modelMatch = modelIso.match(ISO_RE);
      if (modelMatch) {
        const modelMonth = Number(modelMatch[2]) - 1;
        const modelDay = Number(modelMatch[3]);
        if (modelMonth !== md.month || modelDay !== md.day) {
          rejected.unverifiable += 1;
          continue;
        }
      }
      resolvedDate = resolved.date;
      yearInferred = resolved.yearInferred;
      dateBasis = "absolute";
    }

    // 4. A reminder in the past (by TODAY, not the anchor) is noise the user has to clear.
    if (resolvedDate < todayStart) {
      rejected.past += 1;
      continue;
    }

    const title = item.title.trim();
    if (!title) {
      rejected.unverifiable += 1;
      continue;
    }

    const dedupeKey = `${toIsoDay(resolvedDate)}|${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const actionKind: ReminderActionKind =
      item.kind && isReminderActionKind(item.kind)
        ? item.kind
        : inferReminderActionKind({
            title,
            description: item.detail,
            reminderType: "extracted_date",
            contactId: null,
          });

    commitments.push({
      title,
      description: item.detail,
      rawDatePhrase: phrase,
      dueDate: atLocalNoon(resolvedDate),
      yearInferred,
      personName: item.person_name,
      actionKind,
      confidenceScore: Math.round(item.confidence * 100),
      sourceExcerpt: item.source_excerpt || phrase,
      dateBasis,
      anchorIso,
    });

    if (commitments.length >= MAX_COMMITMENTS) break;
  }

  return { commitments, rejected };
}

/* ------------------------------------------------------------------ */
/* The AI call                                                         */
/* ------------------------------------------------------------------ */

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function buildSystemPrompt(todayIso: string, todayWeekday: string) {
  return `You extract dated commitments and events from meeting or chat notes for a personal CRM.

TODAY IS ${todayIso} (${todayWeekday}). Use today's date for one purpose only: filling in a year the notes did not state.

Return strict JSON matching this shape:
{
  "commitments": [
    {
      "title": string,
      "detail": string|null,
      "raw_date_phrase": string,
      "date": "YYYY-MM-DD",
      "date_kind": "absolute"|"relative"|"vague",
      "year_stated": boolean,
      "person_name": string|null,
      "kind": "call"|"email"|"meet"|"task"|"follow_up",
      "confidence": 0-1,
      "source_excerpt": string
    }
  ]
}

DATED COMMITMENTS. Extract every commitment, follow-up, deadline, or event the notes attach a time to, whether the time is:
- an absolute calendar date ("Sept 2", "December 1", "15th of October", "9/2", "2026-09-02"), or
- a relative phrase ("next Tuesday", "in two weeks", "end of the month", "Q4", "tomorrow", "after the holidays"), or
- a vague phrase ("soon", "at some point", "when you get a chance").
- DISCARD commitments with no time reference at all ("I'll send the deck", "we should grab coffee").
- NEVER rewrite a relative or vague phrase into a calendar date. Copy it verbatim into raw_date_phrase and leave "date" as "" for those.

Field rules:
- raw_date_phrase: the time text copied VERBATIM from the notes, exactly as written and nothing more — for "she'll send it in two weeks" that is "in two weeks". It must appear character-for-character in the notes.
- date_kind: "absolute" when raw_date_phrase names a month or numeric date, "relative" when it is anchored to now/the meeting ("next", "in N", "tomorrow", "end of"), "vague" when it names no interval ("soon", "sometime").
- date: for absolute phrases only, YYYY-MM-DD (infer the nearest FUTURE year when unstated, year_stated=false). For relative and vague phrases use "".
- title: a short event or action name, 3 to 8 words, e.g. "Project kickoff", "AWS re:Invent", "Board review". Never put the date in the title.
- detail: one sentence of supporting context from the notes, or null.
- person_name: the person this involves, spelled exactly as the notes spell it. Use null when the notes name nobody (a conference, an internal review, a deadline).
- kind: "meet" for meetings, events, and conferences; "call" for phone or video calls; "email" for sending something in writing; "follow_up" for checking back in with someone; "task" for everything else.
- confidence: 0-1. Below 0.5 when the date is explicit but the commitment itself is vague.
- source_excerpt: the sentence or short passage the commitment came from, copied verbatim from the notes.

Other rules:
- Use only dates, people, and facts present in the notes. Never invent a date, a person, or an event.
- Do not extract dates describing something already finished that needs no action ("we met on Aug 3", "she joined in 2019", "shipped it March 4"). Only extract things the user should be reminded about.
- One object per distinct commitment. If the same event is mentioned twice, emit it once.
- Return {"commitments": []} when the notes contain no dated commitments. An empty array is a correct and very common answer.`;
}

export async function fetchRawCommitments(
  userId: string,
  notes: string,
  options?: { today?: Date; knownPeople?: string[] }
): Promise<RawCommitmentItem[]> {
  const trimmed = notes.trim();
  if (!trimmed) return [];
  const today = options?.today ?? new Date();
  const todayIso = toIsoDay(today);
  const todayWeekday = WEEKDAY_NAMES[today.getDay()];
  const corpus = trimmed.slice(0, MAX_NOTE_CHARS);
  const people = (options?.knownPeople || []).filter(Boolean);
  const peopleBlock = people.length
    ? `People likely mentioned:\n- ${people.join("\n- ")}\n\n`
    : "";
  // Today is repeated in the user turn because Gemini takes systemInstruction as a
  // separate config field, where it carries less weight than inline content.
  const content = await completeJson(userId, {
    operation: "capture.dates",
    temperature: 0.1,
    maxOutputTokens: 2048,
    system: buildSystemPrompt(todayIso, todayWeekday),
    user: `Today: ${todayIso} (${todayWeekday})\n\n${peopleBlock}Notes:\n${corpus}`,
  });
  return datedCommitmentsSchema.parse(JSON.parse(content)).commitments;
}

export async function extractDatedCommitments(
  userId: string,
  notes: string,
  options?: { today?: Date; anchor?: Date; knownPeople?: string[] }
): Promise<DatedCommitmentResult> {
  const today = options?.today ?? new Date();
  const raw = await fetchRawCommitments(userId, notes, {
    today,
    knownPeople: options?.knownPeople,
  });
  return validateCommitments(raw, notes.trim().slice(0, MAX_NOTE_CHARS), {
    today,
    anchor: options?.anchor,
  });
}
