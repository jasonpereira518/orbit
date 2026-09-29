/**
 * The richer half of a captured person: takeaways, personal details, work context, handles,
 * who they know, and what was promised in each direction.
 *
 * Kept out of `src/lib/ai.ts` for the reason `ai-opportunity-schema.ts` is: the validators
 * are pure and driven by `tsx` smoke scripts with no API key, and `ai.ts` drags in three
 * vendor SDKs. `ai.ts` spreads `personEnrichmentFields` into `noteParseSchema`.
 *
 * ## Every field is optional
 *
 * Not only for the model's sake. A parsed person is persisted on the capture job, and jobs
 * parsed before these fields existed are still reviewable — so the TYPE has to say "may be
 * absent", or every reader would trust a key an old row never had.
 *
 * ## Tolerant lists
 *
 * These lists sit inside `people[]`, where one malformed member fails the WHOLE response
 * under a strict schema. `tolerantList` parses members one at a time and drops the bad
 * ones, so a sloppy connection costs one connection, not every person in the note.
 *
 * ## The prompt is only a filter
 *
 * Same contract as opportunities and implied steps: connections and promises must point at
 * the sentence they came from, and `validateConnections` / `validatePromises` check it
 * verbatim. Takeaways and personal details carry no excerpt — they are the model's reading
 * of the note, shown for the person to edit — so they are only cleaned and capped.
 */
import { z } from "zod";
import { titlesCollide } from "@/lib/note-batches";
import { containsVerbatim, normalizeForMatch } from "@/lib/verbatim";

const nullTrimmed = z
  .string()
  .nullish()
  .transform((v) => v?.replace(/\s+/g, " ").trim() || null);

const excerpt = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || "");

function tolerantList<T extends z.ZodTypeAny>(item: T) {
  return z
    .array(z.unknown())
    .nullish()
    .transform((v): z.output<T>[] =>
      (v ?? []).flatMap((raw) => {
        const parsed = item.safeParse(raw);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      })
    );
}

const looseStrList = z
  .array(z.unknown())
  .nullish()
  .transform((v) => (v ?? []).filter((s): s is string => typeof s === "string"));

export const personWorkSchema = z
  .object({
    team: nullTrimmed,
    building: nullTrimmed,
    priorities: looseStrList,
    hiring: nullTrimmed,
    looking_for: nullTrimmed,
  })
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);

export type PersonWork = NonNullable<z.output<typeof personWorkSchema>>;

export const personConnectionSchema = z.object({
  name: z.string().transform((v) => v.replace(/\s+/g, " ").trim()),
  /** "works with", "offered to intro me to", "her cofounder" — the note's own framing. */
  relation: nullTrimmed,
  source_excerpt: excerpt,
});

export type PersonConnection = z.output<typeof personConnectionSchema>;

export type PromiseDirection = "you_owe" | "they_owe";

export const personPromiseSchema = z.object({
  direction: z
    .string()
    .nullish()
    .transform((v): PromiseDirection | null =>
      v === "you_owe" || v === "they_owe" ? v : null
    ),
  /** A verb phrase with no subject — "send the Q3 deck" — so either framing reads. */
  text: z.string().transform((v) => v.replace(/\s+/g, " ").trim()),
  due_phrase: nullTrimmed,
  source_excerpt: excerpt,
});

export type PersonPromise = Omit<z.output<typeof personPromiseSchema>, "direction"> & {
  direction: PromiseDirection;
};

/**
 * Spread into `noteParseSchema`. Each is `.optional()` on the OUTPUT too — see the header:
 * an old job's parsed person simply has none of these.
 */
export const personEnrichmentFields = {
  takeaways: looseStrList.optional(),
  personal_details: looseStrList.optional(),
  work: personWorkSchema.optional(),
  phone: nullTrimmed.optional(),
  x_handle: nullTrimmed.optional(),
  website: nullTrimmed.optional(),
  school: nullTrimmed.optional(),
  industry: nullTrimmed.optional(),
  connections: tolerantList(personConnectionSchema).optional(),
  promises: tolerantList(personPromiseSchema).optional(),
};

export const MAX_TAKEAWAYS = 6;
export const MAX_PERSONAL_DETAILS = 8;
export const MAX_CONNECTIONS = 8;
export const MAX_PROMISES = 8;
const MAX_LINE_CHARS = 240;

/** Trim, strip a bullet the model typed itself, drop blanks and repeats, cap. */
export function cleanLines(lines: readonly string[] | undefined, cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines ?? []) {
    const line = raw
      .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LINE_CHARS);
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

/** "@jdoe", "x.com/jdoe", "https://twitter.com/jdoe" → "jdoe". Null for anything else. */
export function normalizeXHandle(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const fromUrl = v.match(/(?:twitter\.com|x\.com)\/@?([A-Za-z0-9_]{1,15})\b/i);
  const handle = fromUrl?.[1] ?? v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

/** A phone number needs at least seven digits; the note's formatting is kept as written. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const v = raw?.replace(/\s+/g, " ").trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return /^[+\d\s().-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(v) ? v : null;
}

/**
 * A personal or company site. LinkedIn and X have their own fields, so a profile URL here
 * would be a second copy of the same handle under a less useful label.
 */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v || /\s/.test(v)) return null;
  if (/(?:linkedin\.com|twitter\.com|x\.com)\//i.test(v)) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const url = new URL(withScheme);
    return url.hostname.includes(".") ? withScheme : null;
  } catch {
    return null;
  }
}

/**
 * Who this person knows, pointed at the sentence that says so.
 *
 * `selfName` is the person the connection hangs on — "Maya knows Maya" is the model echoing
 * the card, never a relationship.
 */
export function validateConnections(
  raw: readonly PersonConnection[] | undefined,
  notes: string,
  selfName: string | null
): PersonConnection[] {
  const haystack = normalizeForMatch(notes);
  const self = selfName?.trim().toLowerCase() ?? "";
  const seen = new Set<string>();
  const out: PersonConnection[] = [];
  for (const c of raw ?? []) {
    const key = c.name.toLowerCase();
    if (!c.name || key === self || seen.has(key)) continue;
    if (!containsVerbatim(haystack, c.source_excerpt)) continue;
    seen.add(key);
    out.push({
      name: c.name.slice(0, 120),
      relation: c.relation?.slice(0, 120) ?? null,
      source_excerpt: c.source_excerpt.replace(/\s+/g, " ").trim().slice(0, 500),
    });
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}

/**
 * Promises in both directions, verified against the note. A promise with no direction is
 * dropped rather than guessed at: filing "they owe you" as "you owe them" puts a task on the
 * wrong person's plate.
 */
export function validatePromises(
  raw: readonly z.output<typeof personPromiseSchema>[] | undefined,
  notes: string
): PersonPromise[] {
  const haystack = normalizeForMatch(notes);
  const out: PersonPromise[] = [];
  for (const p of raw ?? []) {
    if (!p.direction || !p.text) continue;
    if (!containsVerbatim(haystack, p.source_excerpt)) continue;
    if (out.some((o) => o.direction === p.direction && titlesCollide(o.text, p.text))) continue;
    out.push({
      direction: p.direction,
      text: p.text.slice(0, 300),
      due_phrase: p.due_phrase,
      source_excerpt: p.source_excerpt.replace(/\s+/g, " ").trim().slice(0, 500),
    });
    if (out.length >= MAX_PROMISES) break;
  }
  return out;
}

/**
 * The promises worth a reminder draft: the ones no other pass already turned into one.
 * The person pass's `action_items` and the dates pass read the same note and agree often,
 * so without this a "send the deck Friday" arrives two or three times.
 */
export function promisesNeedingReminders(
  promises: readonly z.output<typeof personPromiseSchema>[],
  known: readonly string[]
): PersonPromise[] {
  const titles = known.filter(Boolean);
  // Typed as the raw shape because that is what a parsed person carries; by the time one
  // reaches here `validatePromises` has already dropped the direction-less ones.
  return promises.filter(
    (p): p is PersonPromise => p.direction !== null && !titles.some((k) => titlesCollide(k, p.text))
  );
}

/** The reminder title for a promise, phrased for the person who has to act. */
export function promiseReminderTitle(promise: PersonPromise, personName: string | null): string {
  if (promise.direction === "you_owe") {
    const t = promise.text;
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  // Not "check in if they haven't <verb>": the text is an imperative verb phrase, and no
  // tense rewrite of arbitrary model output is safe. "Waiting on Maya: send the deck" is.
  return `Waiting on ${personName?.trim() || "them"}: ${promise.text}`;
}

/** A work block as edited on a card: trimmed, capped, and null when nothing is left. */
export function cleanWork(work: Partial<PersonWork> | null | undefined): PersonWork | null {
  if (!work) return null;
  const line = (v: string | null | undefined) => v?.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS) || null;
  const out: PersonWork = {
    team: line(work.team),
    building: line(work.building),
    priorities: cleanLines(work.priorities ?? [], 5),
    hiring: line(work.hiring),
    looking_for: line(work.looking_for),
  };
  const empty = !out.team && !out.building && !out.priorities.length && !out.hiring && !out.looking_for;
  return empty ? null : out;
}

/** A person's takeaways as one block, for readers that only know the old `summary`. */
export function takeawaysToSummary(takeaways: readonly string[]): string | null {
  return takeaways.length ? takeaways.map((t) => `• ${t}`).join("\n") : null;
}

/** The inverse, for a summary edited on the card or saved before takeaways existed. */
export function summaryToTakeaways(summary: string | null | undefined): string[] {
  if (!summary?.trim()) return [];
  const lines = summary.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return cleanLines(lines.length > 1 ? lines : [summary], MAX_TAKEAWAYS);
}

/**
 * The facts worth keeping on the contact beyond the takeaways, each labelled so a later
 * reader — or the chat's retrieval — can tell a hobby from a hiring plan. `keyFacts` is a
 * flat list, and a prefix is the cheapest structure it can carry.
 */
export function enrichmentKeyFacts(input: {
  personal_details?: readonly string[];
  work?: PersonWork | null;
  connections?: readonly PersonConnection[];
}): string[] {
  const facts: string[] = [];
  for (const d of input.personal_details ?? []) facts.push(`Personal: ${d}`);
  const w = input.work;
  if (w?.team) facts.push(`Team: ${w.team}`);
  if (w?.building) facts.push(`Building: ${w.building}`);
  for (const p of w?.priorities ?? []) facts.push(`Priority: ${p}`);
  if (w?.hiring) facts.push(`Hiring: ${w.hiring}`);
  if (w?.looking_for) facts.push(`Looking for: ${w.looking_for}`);
  for (const c of input.connections ?? []) {
    facts.push(`Knows: ${c.name}${c.relation ? ` (${c.relation})` : ""}`);
  }
  return facts;
}
