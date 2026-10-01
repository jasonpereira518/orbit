/**
 * An email event, as one searchable passage.
 *
 * `email_events` holds what an email meant (a company, a role, a stage, dates, who was named,
 * what was asked, one short quote copied from the mail). Chat answers questions about what was
 * said and when from `memory_chunks`; this is the pure step that turns one event into the text
 * and chunk drafts that go there, so "what did the recruiter at Northwind say about the
 * screen" can be answered from the user's mail the way it is from their notes.
 *
 * Pure: the database half (what is stale, who the named people resolve to, the write) is
 * `search-index.ts`.
 *
 * ## What goes in, and what never does
 *
 * The derived facts and the one verified quote, which is what the feature already stores and
 * shows. Never an address (people are named, not addressed, so an address cannot be searched
 * for or quoted back by a chat answer), never a message body, never a thread header.
 *
 * Every string here was written by a model from someone else's mail and will be shown to the
 * user's own model as evidence, so each is cleaned to one line and capped, and a field that
 * trips the injection detector is dropped. A suspicious summary, company, role or stage drops
 * the whole event: those carry the meaning, and what is left would be a guess.
 *
 * The passage has no contact ids in it, deliberately. Who an address belongs to changes (a
 * merge, a contact added later, `Add to Orbit`), and a hash over text that included it would
 * re-embed on every such change. Ids live in the chunk's `contact_ids` column, which is
 * rewritten in place without touching the embedding.
 */
import { cleanSingleLine, detectInjectionSignals } from "@/lib/ai-security";
import { buildMemoryChunks, type MemoryChunkDraft } from "@/lib/memory-chunks";
import type { EmailEventKind, EmailEventPerson } from "./types";

export const EMAIL_PASSAGE_KIND_LABELS: Record<Exclude<EmailEventKind, "other">, string> = {
  process_update: "Hiring update",
  job_posting: "Job posting",
  news: "News",
  event: "Event",
};

/** An `email_events` row as the indexer selects it. `version` is computed in SQL (see `search-index.ts`). */
export type IndexableEvent = {
  id: string;
  kind: Exclude<EmailEventKind, "other">;
  company: string | null;
  role: string | null;
  stage: string | null;
  occurred_at: string | Date;
  due_at: string | Date | null;
  summary: string;
  evidence_quote: string;
  people: EmailEventPerson[] | null;
  asks: string[] | null;
  version: string;
};

const MAX_PEOPLE = 6;
const MAX_ASKS = 3;

function clean(value: string | null | undefined, max: number): string | null {
  const text = cleanSingleLine(value, max);
  return text && detectInjectionSignals(text).length === 0 ? text : null;
}

function day(value: string | Date | null): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/** Present but suspicious is not the same as absent: the whole event is refused, not half of it. */
function suspicious(value: string | null | undefined, max: number): boolean {
  const text = cleanSingleLine(value, max);
  return text !== null && detectInjectionSignals(text).length > 0;
}

/** The text of the passage, or null when the event cannot be written safely. */
export function emailEventPassage(event: IndexableEvent): string | null {
  const summary = clean(event.summary, 300);
  if (!summary) return null;
  if (suspicious(event.company, 80) || suspicious(event.role, 80) || suspicious(event.stage, 40)) return null;
  const company = clean(event.company, 80);
  const role = clean(event.role, 80);
  const stage = clean(event.stage, 40);
  const due = day(event.due_at);

  const facts = [
    company && `Company: ${company}`,
    role && `Role: ${role}`,
    stage && `Stage: ${stage}`,
    due && `Due: ${due}`,
  ].filter((p): p is string => Boolean(p));
  const asks = (event.asks ?? [])
    .map((a) => clean(a, 160))
    .filter((a): a is string => a !== null)
    .slice(0, MAX_ASKS);
  const people = (event.people ?? [])
    .map((p) => {
      const name = clean(p.name, 60);
      if (!name) return null;
      const title = clean(p.title, 80);
      return title ? `${name} (${title})` : name;
    })
    .filter((p): p is string => p !== null)
    .slice(0, MAX_PEOPLE);
  const quote = clean(event.evidence_quote, 200);

  return [
    `${EMAIL_PASSAGE_KIND_LABELS[event.kind]}: ${summary}`,
    facts.length ? facts.join(" · ") : null,
    asks.length ? `Asks: ${asks.join("; ")}` : null,
    people.length ? `People: ${people.join("; ")}` : null,
    quote ? `Quote: “${quote}”` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Chunk drafts for one event: always at most one, since a passage this short is never split. */
export function emailEventDrafts(
  event: IndexableEvent,
  who: { contactId: string | null; contactIds: string[] }
): MemoryChunkDraft[] {
  const text = emailEventPassage(event);
  if (!text) return [];
  return buildMemoryChunks({
    text,
    occurredAt: new Date(event.occurred_at),
    kindLabel: "Email",
    contactId: who.contactId,
    contactName: null,
    contactIds: who.contactIds,
  });
}
