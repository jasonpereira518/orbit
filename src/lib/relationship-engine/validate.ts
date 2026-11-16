/**
 * Turns a model answer into claims the engine can act on. Three rules, all from capture:
 *
 *  1. Every excerpt must be found, verbatim, in ONE message of the window. That message is
 *     the item's provenance: its date anchors relative phrases and its id becomes the
 *     reminder's source interaction.
 *  2. Dates go through capture's `validateCommitments` with BOTH `today` and `anchor` set to
 *     the message's date. `today` there decides the year of "March 5" and rejects dates in
 *     the past; for a message from 2024 the right "today" is that day, not this one. Whether
 *     the date is still ahead of the real today is rules.ts's question, not this file's.
 *  3. Implied items need IMPLIED_MIN_CONFIDENCE.
 */
import { validateCommitments, type RawCommitmentItem } from "@/lib/date-commitment-extract";
import { IMPLIED_MIN_CONFIDENCE } from "@/lib/implied-next-steps";
import { normalizeForMatch } from "@/lib/verbatim";
import type { RelationshipDigestAnswer } from "@/lib/relationship-engine/extract";
import type { MessageWindow, ValidatedDigest, ValidatedEvent, WindowMessage } from "@/lib/relationship-engine/types";
import { RELATIONSHIP_KINDS, type DatePrecision, type RelationshipKind } from "@/db/schema";
import { cleanSingleLine } from "@/lib/ai-security";
import { isMetContext } from "@/lib/met-context";

/**
 * The floor for an excerpt to count as evidence. A substring test alone accepted "ok" — found
 * inside "Looking" in almost any thread — so a model (or a sender's prompt injection) could back
 * an invented fact or to-do by quoting two letters. Two words and ten characters is short enough
 * for every real quote the prompt asks for ("I know Priya", "send the deck") and long enough
 * that it has to say something.
 */
const MIN_EXCERPT_CHARS = 10;
const MIN_EXCERPT_WORDS = 2;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** `needle` in `haystack` with no word character glued to either end ("ok" is not in "looking"). */
function containsOnWordBoundaries(haystack: string, needle: string): boolean {
  const guardStart = WORD_CHAR.test(needle[0]);
  const guardEnd = WORD_CHAR.test(needle[needle.length - 1]);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (guardStart && before !== undefined && WORD_CHAR.test(before)) continue;
    if (guardEnd && after !== undefined && WORD_CHAR.test(after)) continue;
    return true;
  }
  return false;
}

export function locateExcerpt(window: MessageWindow, excerpt: string): WindowMessage | null {
  const needle = normalizeForMatch(excerpt);
  if (needle.length < MIN_EXCERPT_CHARS || needle.split(" ").length < MIN_EXCERPT_WORDS) return null;
  // Newest first: a phrase repeated across messages is attributed to its latest use.
  for (let i = window.messages.length - 1; i >= 0; i--) {
    if (containsOnWordBoundaries(normalizeForMatch(window.messages[i].text), needle)) return window.messages[i];
  }
  return null;
}

const EVENT_TYPES = new Set<ValidatedEvent["type"]>(["meeting", "in_person", "call"]);
const KINDS = new Set<string>(RELATIONSHIP_KINDS);

function realDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A model date by its shape only: YYYY-MM-DD, YYYY-MM or YYYY. Coarser dates are stored as their 1st. */
export function readModelDate(raw: string): { date: string; precision: DatePrecision } | null {
  const s = raw.trim();
  // Nobody's "how we met" predates 1900; a year like that is a model artifact, not a date.
  if (+s.slice(0, 4) < 1900) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return realDay(+m[1], +m[2], +m[3]) ? { date: s, precision: "day" } : null;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return +m[2] >= 1 && +m[2] <= 12 ? { date: `${s}-01`, precision: "month" } : null;
  m = /^(\d{4})$/.exec(s);
  return m ? { date: `${s}-01-01`, precision: "year" } : null;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** An excerpt kept on the digest is re-read by later prompts and shown on the contact page: one capped line. */
const storedExcerpt = (excerpt: string) => cleanSingleLine(excerpt, 300) ?? "";

export function validateDigest(
  answer: RelationshipDigestAnswer,
  window: MessageWindow,
  openKeys: Set<string>,
  opts: { deepRead?: boolean } = {}
): ValidatedDigest {
  const facts = answer.facts.filter((f) => locateExcerpt(window, f.excerpt)).map((f) => f.text.trim());

  const dated: ValidatedDigest["dated"] = [];
  const undated: ValidatedDigest["undated"] = [];
  for (const c of answer.commitments) {
    const msg = locateExcerpt(window, c.excerpt);
    if (!msg) continue;
    if (c.raw_date_phrase) {
      const raw: RawCommitmentItem = {
        title: c.title,
        detail: null,
        raw_date_phrase: c.raw_date_phrase,
        date: c.date,
        date_kind: c.date_kind,
        year_stated: c.year_stated,
        person_name: null,
        kind: c.kind,
        confidence: c.confidence,
        source_excerpt: c.excerpt,
      };
      const { commitments } = validateCommitments([raw], msg.text, { today: msg.at, anchor: msg.at });
      const ok = commitments[0];
      if (ok) {
        dated.push({
          text: ok.title,
          owedBy: c.owed_by,
          dueDate: ok.dueDate,
          rawDatePhrase: ok.rawDatePhrase,
          dateBasis: ok.dateBasis,
          actionKind: ok.actionKind,
          confidence: ok.confidenceScore,
          excerpt: c.excerpt,
          messageAt: msg.at,
          interactionId: msg.interactionId,
        });
        continue;
      }
      // A date that will not resolve still leaves a real commitment: keep it undated.
    }
    undated.push({
      text: c.title.trim(),
      owedBy: c.owed_by,
      origin: "explicit",
      confidence: Math.round(c.confidence * 100),
      excerpt: c.excerpt,
      messageAt: msg.at,
      interactionId: msg.interactionId,
      withinDays: null,
    });
  }

  for (const i of answer.implied) {
    if (i.confidence < IMPLIED_MIN_CONFIDENCE) continue;
    const msg = locateExcerpt(window, i.excerpt);
    if (!msg) continue;
    undated.push({
      text: i.text.trim(),
      owedBy: i.owed_by,
      origin: "implied",
      confidence: Math.round(i.confidence * 100),
      excerpt: i.excerpt,
      messageAt: msg.at,
      interactionId: msg.interactionId,
      withinDays: i.within_days != null && i.within_days >= 1 && i.within_days <= 365 ? i.within_days : null,
    });
  }

  const closedKeys = [...new Set(answer.closed.map((c) => c.key))].filter(
    (k) => openKeys.has(k) && answer.closed.some((c) => c.key === k && locateExcerpt(window, c.excerpt))
  );

  let jobChange: ValidatedDigest["jobChange"] = null;
  if (answer.job_change) {
    const msg = locateExcerpt(window, answer.job_change.excerpt);
    if (msg && msg.direction === "in") {
      jobChange = { company: answer.job_change.company.trim(), title: answer.job_change.title, messageAt: msg.at };
    }
  }

  // Deep read: origin, relationship kind and events. Quote-or-drop, like everything above, and
  // no date may be later than the message that states it.
  let origin: ValidatedDigest["origin"] = null;
  let relationship: ValidatedDigest["relationship"] = null;
  const events: ValidatedDigest["events"] = [];
  if (opts.deepRead) {
    const o = answer.origin ?? null;
    const oMsg = o ? locateExcerpt(window, o.excerpt) : null;
    if (o && oMsg) {
      const when = o.date ? readModelDate(o.date) : null;
      // A period that starts after the message is a claim the message cannot have made.
      if (!when || when.date <= dayOf(oMsg.at)) {
        const text = cleanSingleLine(o.text, 200);
        if (text) {
          origin = {
            text,
            date: when?.date ?? null,
            precision: when?.precision ?? null,
            context: o.context && isMetContext(o.context) ? o.context : null,
            excerpt: storedExcerpt(o.excerpt),
            interactionId: oMsg.interactionId,
          };
        }
      }
    }
    const r = answer.relationship ?? null;
    const rMsg = r && KINDS.has(r.kind) ? locateExcerpt(window, r.excerpt) : null;
    if (r && rMsg) relationship = { kind: r.kind as RelationshipKind, excerpt: storedExcerpt(r.excerpt), interactionId: rMsg.interactionId };
    for (const e of answer.events ?? []) {
      if (!EVENT_TYPES.has(e.type as ValidatedEvent["type"])) continue;
      const msg = locateExcerpt(window, e.excerpt);
      const summary = cleanSingleLine(e.summary, 200);
      if (!msg || !summary) continue;
      const said = readModelDate(e.date);
      const msgDay = dayOf(msg.at);
      const day = said?.precision === "day" && said.date <= msgDay ? said.date : msgDay;
      events.push({ type: e.type as ValidatedEvent["type"], summary, day, excerpt: storedExcerpt(e.excerpt), interactionId: msg.interactionId });
    }
  }

  return {
    origin,
    relationship,
    events,
    whatTheyDo: answer.what_they_do,
    workingOn: answer.working_on,
    summary: answer.summary,
    topics: answer.topics,
    facts,
    dated,
    undated,
    closedKeys,
    jobChange,
  };
}
