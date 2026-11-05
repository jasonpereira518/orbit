/**
 * Past meetings: a page at a time with search, and the passage search Chat uses.
 *
 * Read-only over `meeting_sessions` and `meeting_transcript_segments`, and split from the
 * `"use server"` wrappers the same way `capture-history.ts` is, so
 * `scripts/smoke-meetings-list.ts` can drive it against PGlite with no auth. Every query is
 * scoped to the user it is handed.
 *
 * Granola-synced notes are listed alongside, from the batches the sync saved (see
 * `listGranola`).
 *
 * Only finished meetings are listed (`analyzed` or `saved`). One still recording, or ended
 * but not yet summarized, is the resume banner's business, not history's.
 *
 * Search is `ILIKE` over the title, the summary, the guest names and the transcript. That is
 * a scan, bounded by one user's meetings — fine at this scale; a tsvector over the segment
 * text is the upgrade if it ever is not.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions, meetingSessions, meetingTranscriptSegments, noteBatches, type MeetingSessionStatus } from "@/db/schema";

export const MEETINGS_PAGE = 20;
const LISTED: MeetingSessionStatus[] = ["analyzed", "saved"];
const MAX_QUERY_CHARS = 100;

/** Recorded in Orbit, or synced from Granola. */
export type MeetingSource = "orbit" | "granola";
export type MeetingSourceFilter = MeetingSource | "all";

export type MeetingListItem = {
  /** A meeting session's id, or for Granola the note batch's. */
  id: string;
  source: MeetingSource;
  title: string | null;
  /** ISO. */
  startedAt: string;
  durationMs: number;
  status: "analyzed" | "saved";
  attendees: string[];
  /** The digest's summary, trimmed for a list. */
  summary: string | null;
  noteBatchId: string | null;
  /** With a search: the first line of transcript that matched, and when it was said. */
  match: { startMs: number; excerpt: string } | null;
};

export type MeetingsPage = {
  items: MeetingListItem[];
  /** Opaque; hand it back for the next page. Null when there is nothing older. */
  nextCursor: string | null;
};

/** `started_at` as Postgres prints it (microseconds survive; a JS Date would round them), then the id. */
function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(at)) return null;
  return { at, id };
}

/** A user's text as a LIKE pattern: wildcards are theirs to type, not to have interpreted. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** A short window of `text` around the first occurrence of `needle` (case-insensitive). */
export function excerptAround(text: string, needle: string, radius = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0 || flat.length <= radius * 2) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export async function listMeetingsFor(
  userId: string,
  opts: { q?: string | null; cursor?: string | null; limit?: number; source?: MeetingSourceFilter } = {}
): Promise<MeetingsPage> {
  const limit = Math.min(Math.max(opts.limit ?? MEETINGS_PAGE, 1), 50);
  const q = (opts.q ?? "").trim().slice(0, MAX_QUERY_CHARS);
  const after = decodeCursor(opts.cursor);
  const source = opts.source ?? "all";

  // One keyset over two tables: each side returns its own `limit + 1` older than the cursor,
  // and the merge keeps the newest `limit`. Anything past the cut on either side is older
  // than it, so the next page's cursor (the last row kept) loses nothing and repeats nothing.
  const [orbit, granola] = await Promise.all([
    source === "granola" ? [] : listRecorded(userId, q, after, limit),
    source === "orbit" ? [] : listGranola(userId, q, after, limit),
  ]);
  const merged = [...orbit, ...granola].sort(
    (a, b) => b.atMs - a.atMs || (a.atText < b.atText ? 1 : a.atText > b.atText ? -1 : 0) || (a.item.id < b.item.id ? 1 : -1)
  );
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => r.item),
    nextCursor: merged.length > limit && last ? `${last.atText}|${last.item.id}` : null,
  };
}

type Ranked = { atMs: number; atText: string; item: MeetingListItem };

async function listRecorded(
  userId: string,
  q: string,
  after: { at: string; id: string } | null,
  limit: number
): Promise<Ranked[]> {
  const db = await getDb();
  const conditions: (SQL | undefined)[] = [
    eq(meetingSessions.userId, userId),
    inArray(meetingSessions.status, LISTED),
    after
      ? sql`(${meetingSessions.startedAt}, ${meetingSessions.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : undefined,
  ];
  if (q) {
    const pattern = likePattern(q);
    conditions.push(sql`(
      ${meetingSessions.title} ILIKE ${pattern}
      OR ${meetingSessions.digest}->>'summary' ILIKE ${pattern}
      OR ${meetingSessions.attendees}::text ILIKE ${pattern}
      OR ${meetingSessions.userNotes} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM ${meetingTranscriptSegments}
        WHERE ${meetingTranscriptSegments.sessionId} = ${meetingSessions.id}
          AND ${meetingTranscriptSegments.userId} = ${userId}
          AND ${meetingTranscriptSegments.text} ILIKE ${pattern}
      )
    )`);
  }

  const rows = await db
    .select({
      id: meetingSessions.id,
      title: meetingSessions.title,
      startedAt: meetingSessions.startedAt,
      startedAtText: sql<string>`${meetingSessions.startedAt}::text`,
      durationMs: meetingSessions.durationMs,
      status: meetingSessions.status,
      attendees: meetingSessions.attendees,
      summary: sql<string | null>`left(${meetingSessions.digest}->>'summary', 400)`,
      digestTitle: sql<string | null>`${meetingSessions.digest}->>'title'`,
      noteBatchId: meetingSessions.noteBatchId,
    })
    .from(meetingSessions)
    .where(and(...conditions))
    .orderBy(desc(meetingSessions.startedAt), desc(meetingSessions.id))
    .limit(limit + 1);

  // With a search, show WHY each row matched: the first transcript line that did.
  const matches = new Map<string, { startMs: number; excerpt: string }>();
  if (q && rows.length) {
    const hits = await db
      .selectDistinctOn([meetingTranscriptSegments.sessionId], {
        sessionId: meetingTranscriptSegments.sessionId,
        startMs: meetingTranscriptSegments.startMs,
        text: meetingTranscriptSegments.text,
      })
      .from(meetingTranscriptSegments)
      .where(
        and(
          eq(meetingTranscriptSegments.userId, userId),
          inArray(
            meetingTranscriptSegments.sessionId,
            rows.map((r) => r.id)
          ),
          sql`${meetingTranscriptSegments.text} ILIKE ${likePattern(q)}`
        )
      )
      .orderBy(meetingTranscriptSegments.sessionId, meetingTranscriptSegments.seq);
    for (const h of hits) matches.set(h.sessionId, { startMs: h.startMs, excerpt: excerptAround(h.text, q) });
  }

  return rows.map((r) => ({
    atMs: r.startedAt.getTime(),
    atText: r.startedAtText,
    item: {
      id: r.id,
      source: "orbit",
      title: r.title?.trim() || r.digestTitle?.trim() || null,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      status: r.status as "analyzed" | "saved",
      attendees: (r.attendees ?? []).map((a) => a.name).filter(Boolean),
      summary: r.summary,
      noteBatchId: r.noteBatchId,
      match: matches.get(r.id) ?? null,
    },
  }));
}

/**
 * Granola notes, one row per saved batch the sync wrote (`ingestNote`). A note that named
 * nobody is never saved, so it is not here either. The date is the meeting's (every
 * interaction of a batch carries it); grouped rather than a correlated subquery, which
 * drizzle renders unqualified in a projection.
 */
async function listGranola(
  userId: string,
  q: string,
  after: { at: string; id: string } | null,
  limit: number
): Promise<Ranked[]> {
  const db = await getDb();
  const at = sql`min(${interactions.interactionDate})`;
  const rows = await db
    .select({
      id: noteBatches.id,
      atMs: sql<number>`(extract(epoch from min(${interactions.interactionDate})) * 1000)::float8`.mapWith(Number),
      atText: sql<string>`min(${interactions.interactionDate})::text`,
      sourceText: noteBatches.sourceText,
      result: noteBatches.result,
    })
    .from(interactions)
    .innerJoin(noteBatches, eq(noteBatches.id, interactions.noteBatchId))
    .where(
      and(
        eq(interactions.userId, userId),
        eq(interactions.source, "granola"),
        eq(noteBatches.userId, userId),
        eq(noteBatches.status, "saved"),
        q ? sql`${noteBatches.sourceText} ILIKE ${likePattern(q)}` : undefined
      )
    )
    .groupBy(noteBatches.id)
    .having(after ? sql`(${at}, ${noteBatches.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined)
    .orderBy(desc(at), desc(noteBatches.id))
    .limit(limit + 1);

  return rows.map((r) => {
    const note = parseGranolaNote(r.sourceText);
    return {
      atMs: r.atMs,
      atText: r.atText,
      item: {
        id: r.id,
        source: "granola",
        title: note.title,
        startedAt: new Date(r.atMs).toISOString(),
        durationMs: 0,
        status: "saved",
        attendees: r.result.participants.map((p) => p.name).filter(Boolean),
        summary: note.body.replace(/\s+/g, " ").trim().slice(0, 400) || null,
        noteBatchId: r.id,
        match: q ? { startMs: 0, excerpt: excerptAround(r.sourceText, q) } : null,
      },
    };
  });
}

export type GranolaNote = { title: string | null; attendees: string | null; body: string; myNotes: string | null };

/**
 * The text `noteText` (connectors/granola-xml.ts) wrote: "Meeting:", "When:" and
 * "Attendees:" lines, Granola's summary, then "My notes:" — each separated by a blank line.
 */
export function parseGranolaNote(text: string): GranolaNote {
  let rest = text;
  const header = (label: string): string | null => {
    const m = rest.match(new RegExp(`^${label}: (.*)(?:\\n\\n|$)`));
    if (!m) return null;
    rest = rest.slice(m[0].length);
    return m[1].trim() || null;
  };
  const title = header("Meeting");
  header("When");
  const attendees = header("Attendees");
  const at = rest.lastIndexOf("My notes:\n");
  const myNotes = at >= 0 ? rest.slice(at + "My notes:\n".length).trim() || null : null;
  const body = (at >= 0 ? rest.slice(0, at) : rest).trim();
  return { title, attendees, body, myNotes };
}

/** One Granola meeting for `/meetings/g/[id]`: null unless it is this user's saved Granola batch. */
export async function getGranolaMeeting(userId: string, batchId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return null;
  const db = await getDb();
  const [row] = await db
    .select({
      id: noteBatches.id,
      atMs: sql<number>`(extract(epoch from min(${interactions.interactionDate})) * 1000)::float8`.mapWith(Number),
      sourceText: noteBatches.sourceText,
      result: noteBatches.result,
    })
    .from(interactions)
    .innerJoin(noteBatches, eq(noteBatches.id, interactions.noteBatchId))
    .where(
      and(
        eq(noteBatches.id, batchId),
        eq(noteBatches.userId, userId),
        eq(noteBatches.status, "saved"),
        eq(interactions.userId, userId),
        eq(interactions.source, "granola")
      )
    )
    .groupBy(noteBatches.id);
  if (!row) return null;
  return { id: row.id, at: new Date(row.atMs), note: parseGranolaNote(row.sourceText), result: row.result };
}

// ── Chat: passages across meetings ────────────────────────────────────────────────────

export type MeetingPassage = {
  meetingId: string;
  title: string | null;
  /** ISO. */
  date: string;
  /** Where in the meeting, for a transcript passage; null for a summary. */
  startMs: number | null;
  kind: "transcript" | "summary";
  snippet: string;
};

/** Words worth matching: three letters or more, and not filler. */
const FILLER = new Set([
  "the", "and", "for", "that", "with", "what", "did", "say", "said", "about", "was", "were",
  "has", "have", "how", "who", "when", "they", "them", "this", "from", "tell", "meeting",
  "meetings", "call", "talk", "talked",
]);

export function searchWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3 && !FILLER.has(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * The passages of a user's finished meetings that best match a question's keywords: the
 * transcript lines containing the most of them, and the summaries of meetings whose title,
 * summary or guest list mention them (so a name finds that person's meetings even when
 * nobody said it aloud). Newest first among equals.
 *
 * Transcript speakers are Deepgram's "Speaker 2", not names — a passage says WHEN in a
 * meeting something was said, never who said it.
 */
export async function searchMeetingPassagesFor(
  userId: string,
  opts: { query: string; after?: Date | null; before?: Date | null; limit?: number }
): Promise<MeetingPassage[]> {
  const words = searchWords(opts.query.slice(0, 300));
  if (!words.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const db = await getDb();

  const base = [
    eq(meetingSessions.userId, userId),
    inArray(meetingSessions.status, LISTED),
    opts.after ? sql`${meetingSessions.startedAt} >= ${opts.after}` : undefined,
    opts.before ? sql`${meetingSessions.startedAt} < ${opts.before}` : undefined,
  ];
  const anyWord = (col: SQL) =>
    sql.join(
      words.map((w) => sql`${col} ILIKE ${likePattern(w)}`),
      sql` OR `
    );

  const lines = await db
    .select({
      meetingId: meetingSessions.id,
      title: meetingSessions.title,
      digestTitle: sql<string | null>`${meetingSessions.digest}->>'title'`,
      startedAt: meetingSessions.startedAt,
      startMs: meetingTranscriptSegments.startMs,
      text: meetingTranscriptSegments.text,
    })
    .from(meetingTranscriptSegments)
    .innerJoin(meetingSessions, eq(meetingSessions.id, meetingTranscriptSegments.sessionId))
    .where(
      and(
        ...base,
        eq(meetingTranscriptSegments.userId, userId),
        sql`(${anyWord(sql`${meetingTranscriptSegments.text}`)})`
      )
    )
    .orderBy(desc(meetingSessions.startedAt), meetingTranscriptSegments.seq)
    .limit(80);

  const scored: (MeetingPassage & { score: number })[] = lines.map((l) => {
    const lower = l.text.toLowerCase();
    return {
      meetingId: l.meetingId,
      title: l.title?.trim() || l.digestTitle?.trim() || null,
      date: l.startedAt.toISOString(),
      startMs: l.startMs,
      kind: "transcript",
      snippet: excerptAround(l.text, words.find((w) => lower.includes(w)) ?? words[0], 160),
      score: words.filter((w) => lower.includes(w)).length,
    };
  });

  const summaries = await db
    .select({
      meetingId: meetingSessions.id,
      title: meetingSessions.title,
      digestTitle: sql<string | null>`${meetingSessions.digest}->>'title'`,
      startedAt: meetingSessions.startedAt,
      summary: sql<string | null>`left(${meetingSessions.digest}->>'summary', 600)`,
      attendees: meetingSessions.attendees,
    })
    .from(meetingSessions)
    .where(
      and(
        ...base,
        sql`(${anyWord(sql`${meetingSessions.title}`)} OR ${anyWord(sql`${meetingSessions.digest}->>'summary'`)} OR ${anyWord(sql`${meetingSessions.attendees}::text`)})`
      )
    )
    .orderBy(desc(meetingSessions.startedAt))
    .limit(20);

  for (const m of summaries) {
    if (!m.summary) continue;
    const haystack = `${m.title ?? ""} ${m.summary} ${(m.attendees ?? []).map((a) => a.name).join(" ")}`.toLowerCase();
    scored.push({
      meetingId: m.meetingId,
      title: m.title?.trim() || m.digestTitle?.trim() || null,
      date: m.startedAt.toISOString(),
      startMs: null,
      kind: "summary",
      snippet: m.summary,
      // A summary that mentions the keywords outranks a stray line only when it mentions more.
      score: words.filter((w) => haystack.includes(w)).length - 0.5,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || (a.startMs ?? 0) - (b.startMs ?? 0))
    .slice(0, limit)
    .map((p) => ({ meetingId: p.meetingId, title: p.title, date: p.date, startMs: p.startMs, kind: p.kind, snippet: p.snippet }));
}
