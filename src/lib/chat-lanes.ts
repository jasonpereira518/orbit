import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import type { ParsedQuery } from "@/lib/chat-retrieval";
import type { OrgRoster } from "@/lib/chat-roster";
import { plural, toRefs, type StepEmitter } from "@/lib/chat-steps";
import { hybridSearchContacts, listContactsMatching } from "@/lib/hybrid-search";
import { searchMeetingPassagesFor } from "@/lib/meetings-list";
import { searchMemories } from "@/lib/memory-search";

/**
 * One passage about a single interaction or meeting, kept structured so the answer can cite
 * it. Only interaction- and meeting-sourced passages: a note_batch or brief passage has no
 * single dated event to cite and no page to deep-link to.
 */
export type NotePassage = {
  sourceId: string;
  contactId: string | null;
  date: string | null;
  snippet: string;
  /** Omitted for an interaction (the original and still the common case). */
  kind?: "interaction" | "meeting";
  /** A meeting passage: when in the call it was said (null for its summary), and its title. */
  startMs?: number | null;
  title?: string | null;
  /** Who an interaction passage is about, when that contact is still the user's. */
  contactName?: string;
};

/**
 * The retrieval lanes the question's shape picks (see `QuestionShape`), run beside the
 * hybrid search in `retrieveRankedContacts`:
 *
 *  - list / count → `filterLane`: every contact matching the filters and the time window,
 *    with an exact total, handed to the prompt as a roster (the same "complete" block an
 *    organisation roster uses);
 *  - person → `personLane`: the name resolved to one contact, who then gets the focused
 *    contact's deeper slice;
 *  - fact, and a resolved person → `factLane`: passages from the notes (and, for a fact,
 *    recorded meetings), each citable in the answer.
 *
 * Each lane narrates itself and never throws: a lane that fails leaves the answer to the
 * search, exactly as before the lanes existed.
 */

type Named = { id: string; name: string };
type NameHit = Named & { company: string | null; title: string | null };

/* ----------------------------------------------------------------------- filter --- */

function describeFilters(parsed: ParsedQuery): string {
  const parts = Object.entries(parsed.filters)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`);
  const t = parsed.time;
  if (t?.mode === "interacted") {
    parts.push(
      t.after && t.before
        ? `in touch ${t.after} – ${t.before}`
        : t.after
          ? `in touch since ${t.after}`
          : `in touch by ${t.before}`
    );
  } else if (t?.mode === "quiet" && t.after) {
    parts.push(`no contact since ${t.after}`);
  }
  return parts.join(" · ");
}

export async function filterLane(
  userId: string,
  parsed: ParsedQuery,
  steps: StepEmitter
): Promise<OrgRoster | null> {
  if (parsed.shape !== "list" && parsed.shape !== "count") return null;
  const label = describeFilters(parsed);
  if (!label) return null;
  steps.start("filter", `Listing everyone matching ${label}`);
  const listing = await listContactsMatching(userId, { filters: parsed.filters, window: parsed.time }).catch(
    () => null
  );
  if (!listing) {
    steps.done("filter", { label: `Couldn't list everyone matching ${label}` });
    return null;
  }
  steps.done("filter", {
    label: `Found ${plural(listing.total, "person", "people")} matching ${label}`,
    refs: toRefs(listing.people.map((p) => ({ id: p.id, name: p.name })), "contact"),
  });
  return {
    kind: "filter",
    name: `Contacts matching ${label}`,
    total: listing.total,
    people: listing.people.map((p) => ({
      id: p.id,
      name: p.name,
      title:
        [[p.title, p.company].filter(Boolean).join(" @ "), p.lastInteraction ? `last in touch ${p.lastInteraction}` : ""]
          .filter(Boolean)
          .join(" · ") || null,
    })),
    truncated: listing.truncated,
  };
}

/* ----------------------------------------------------------------------- person --- */

const WORD = /[\p{L}\p{N}'’-]+/gu;

function words(s: string): string[] {
  return (s.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 3);
}

/**
 * Contacts whose name answers `name`, best first. `strong`: the name contains the query or
 * the query contains the name ("Dana" ↔ "Dana Wu", "Dana Wu from Stripe" ↔ "Dana Wu").
 * `weak`: they share a whole word of three letters or more — what rescues a misspelled first
 * name ("Jim Okafor" → James Okafor). A search rank alone would promote whoever came top of
 * an unrelated search, so a candidate must pass one of the two.
 */
export async function matchContactsByName(
  userId: string,
  name: string
): Promise<{ strong: NameHit[]; weak: NameHit[] }> {
  const candidates = await hybridSearchContacts(userId, { query: name, limit: 5, withProse: false });
  const needle = name.trim().toLowerCase();
  const needleWords = new Set(words(name));
  const strong: NameHit[] = [];
  const weak: NameHit[] = [];
  for (const c of candidates) {
    const row = { id: c.id, name: c.fullName, company: c.company, title: c.title };
    const names = [c.fullName, c.preferredName ?? ""].map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (names.some((n) => n.includes(needle) || needle.includes(n))) strong.push(row);
    else if (names.some((n) => words(n).some((w) => needleWords.has(w)))) weak.push(row);
  }
  return { strong, weak };
}

/** The one contact a person question is about, or null when the name is missing or ambiguous. */
export async function personLane(
  userId: string,
  parsed: ParsedQuery,
  steps: StepEmitter
): Promise<Named | null> {
  if (parsed.shape !== "person" || !parsed.person) return null;
  const who = parsed.person;
  steps.start("resolve", `Looking for ${who}`);
  const match = await matchContactsByName(userId, who).catch(() => ({ strong: [], weak: [] }));
  const best = match.strong.length ? match.strong : match.weak;
  if (best.length === 1) {
    const person = best[0]!;
    steps.done("resolve", {
      label: `Found ${person.name}`,
      detail: [person.title, person.company].filter(Boolean).join(" @ ") || undefined,
      refs: toRefs([{ id: person.id, name: person.name }], "contact"),
    });
    return { id: person.id, name: person.name };
  }
  // Several people share the name: pinning one would answer about the wrong person. The
  // search beside this still finds them all, and the answer can ask which one was meant.
  steps.done("resolve", {
    label: best.length
      ? `${plural(best.length, "person", "people")} could be ${who}`
      : `No one named ${who} in your contacts`,
    refs: best.length ? toRefs(best.map((p) => ({ id: p.id, name: p.name })), "contact") : undefined,
  });
  return null;
}

/* ------------------------------------------------------------------------- fact --- */

const NOTE_PASSAGES = 6;
const MEETING_PASSAGES = 4;

function dayBound(day: string | undefined, end: boolean): Date | null {
  return day ? new Date(`${day}T${end ? "23:59:59" : "00:00:00"}Z`) : null;
}

/**
 * Passages from the user's notes — and, for a fact question, recorded meetings — that answer
 * it. Scoped to the person a person question resolved to, and to the time window when the
 * question named one. Returns the passages and everyone they name, so the people join the
 * recommendation allowlist and each passage line can say who it is about.
 */
export async function factLane(
  userId: string,
  question: string,
  parsed: ParsedQuery,
  options: { embedding: number[] | null; person: Named | null },
  steps: StepEmitter
): Promise<{ passages: NotePassage[]; people: Named[] }> {
  const person = parsed.shape === "person" ? options.person : null;
  if (parsed.shape !== "fact" && !person) return { passages: [], people: [] };

  const query = [question, ...parsed.expansionTerms].join(" ");
  const window = parsed.time?.mode === "interacted" ? parsed.time : null;
  const after = dayBound(window?.after, false);
  const before = dayBound(window?.before, true);
  steps.start("notes", person ? `Reading your notes on ${person.name}` : "Searching your notes");

  const [memories, meetings] = await Promise.all([
    searchMemories(userId, {
      query,
      embedding: options.embedding,
      contactIds: person ? [person.id] : null,
      after,
      before,
      limit: NOTE_PASSAGES,
    }).catch(() => []),
    // Meetings carry no per-person link, so they answer fact questions only.
    parsed.shape === "fact"
      ? searchMeetingPassagesFor(userId, { query, after, before, limit: MEETING_PASSAGES }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const passages: NotePassage[] = [
    ...memories
      .filter((m) => m.sourceKind === "interaction")
      .map((m) => ({
        sourceId: m.sourceId,
        contactId: m.contactIds[0] ?? m.contactId ?? null,
        date: m.occurredAt ? new Date(m.occurredAt).toISOString().slice(0, 10) : null,
        snippet: m.snippet,
      })),
    ...meetings.map((m) => ({
      kind: "meeting" as const,
      sourceId: m.meetingId,
      contactId: null,
      date: m.date.slice(0, 10),
      snippet: m.snippet,
      startMs: m.startMs,
      title: m.title,
    })),
  ];

  // One user-scoped read for the names, so a passage line can say who it is about.
  const ids = [...new Set(passages.map((p) => p.contactId).filter((id): id is string => Boolean(id)))];
  const people: Named[] = ids.length
    ? await getDb()
        .then((db) =>
          db.query.contacts.findMany({
            where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
            columns: { id: true, fullName: true },
          })
        )
        .then((rows) => rows.map((r) => ({ id: r.id, name: r.fullName })))
        .catch(() => [])
    : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  // A passage naming someone the user no longer has (deleted since it was indexed) stays,
  // unattributed, rather than pointing at a stranger.
  for (const p of passages) {
    const name = p.contactId ? names.get(p.contactId) : undefined;
    if (name) p.contactName = name;
    else p.contactId = null;
  }

  steps.done("notes", {
    label: passages.length
      ? `Found ${plural(passages.length, "passage")} in your ${meetings.length ? "notes and meetings" : "notes"}`
      : "Nothing in your notes on this",
    refs: people.length ? toRefs(people, "contact") : undefined,
  });
  return { passages, people };
}
