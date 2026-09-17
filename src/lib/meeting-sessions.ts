/**
 * The server half of meeting capture: sessions and their transcript segments.
 *
 * No auth and no request scope in here, same split as `note-batch-save.ts`, so that
 * `scripts/smoke-meeting-sessions.ts` can drive every rule against PGlite. The callers —
 * `src/actions/meetings.ts` and `src/app/api/capture/meetings/[id]/chunks/route.ts` — resolve
 * the user first and pass the id in.
 *
 * AUDIO IS NEVER STORED. A chunk arrives as WAV bytes, is transcribed, and only the text is
 * written. That is the same promise `ingestCaptureMedia` makes for every capture upload.
 *
 * Idempotency is the whole design of the segment write. The recorder keeps a chunk in its
 * outbox until this module has acknowledged it, and a flaky connection means the same
 * `(session, seq)` can arrive twice — or arrive after a crashed tab was resumed in a new
 * one. The unique index on `(session_id, seq)` makes a repeat a read of the stored text,
 * never a second transcription and never a repeated line.
 */
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  userSettings,
  type MeetingDigest,
  type MeetingSegmentEngine,
  type MeetingSessionStatus,
  type NoteBatchMeeting,
} from "@/db/schema";
import type { TranscribeOptions, TranscriptionResult } from "@/lib/ai";

export type MeetingAttendee = { name: string; email?: string | null };

export type MeetingSessionRow = typeof meetingSessions.$inferSelect;
export type MeetingSegmentRow = typeof meetingTranscriptSegments.$inferSelect;

/** Sessions nobody finished are swept after this long. Saved ones are kept, like note batches. */
export const ABANDONED_SESSION_TTL_DAYS = 30;

/** How far back the capture page looks for a meeting to offer resuming. */
export const RESUMABLE_WINDOW_DAYS = 7;

/** Statuses a chunk may still land in. `ended` is here for the outbox draining after Stop. */
const ACCEPTS_CHUNKS: MeetingSessionStatus[] = ["recording", "ended"];

/** Statuses the capture page offers to resume. */
const UNFINISHED: MeetingSessionStatus[] = ["recording", "ended", "analyzed"];

export type Transcriber = (
  userId: string,
  input: { mimeType: string; base64: string; filename?: string },
  opts?: TranscribeOptions,
) => Promise<TranscriptionResult>;

/** Loaded lazily so this module stays importable by pure smoke scripts without the AI SDKs. */
const defaultTranscriber: Transcriber = async (userId, input, opts) => {
  const { transcribeAudioWithAI } = await import("@/lib/ai");
  return transcribeAudioWithAI(userId, input, opts);
};

// ── Sessions ──────────────────────────────────────────────────────────────────────────

export async function getMeetingSession(
  userId: string,
  sessionId: string,
): Promise<MeetingSessionRow | null> {
  if (!isUuid(sessionId)) return null;
  const db = await getDb();
  const row = await db.query.meetingSessions.findFirst({
    where: and(eq(meetingSessions.id, sessionId), eq(meetingSessions.userId, userId)),
  });
  return row ?? null;
}

/**
 * Start a new meeting.
 *
 * Any session this user still has marked `recording` is moved to `ended` first: starting a
 * new one is proof the old recorder is gone (a tab can only hold one), and leaving it as
 * `recording` would keep its resume banner pointing at a dead recorder. It keeps its
 * transcript — `ended` still accepts a straggling outbox flush and can still be analyzed.
 *
 * Also the lazy sweep for abandoned sessions, so no cron is needed for them.
 */
export async function createMeetingSessionRow(
  userId: string,
  input: {
    title?: string | null;
    attendees?: MeetingAttendee[];
    includesMic: boolean;
    captureSurface?: string | null;
    recorderId: string;
  },
): Promise<MeetingSessionRow> {
  const db = await getDb();
  const now = new Date();

  await db
    .update(meetingSessions)
    .set({ status: "ended", endedAt: now, updatedAt: now, recorderId: null })
    .where(and(eq(meetingSessions.userId, userId), eq(meetingSessions.status, "recording")));

  await sweepAbandonedSessions(userId, now);

  const [row] = await db
    .insert(meetingSessions)
    .values({
      userId,
      title: cleanTitle(input.title),
      attendees: cleanAttendees(input.attendees),
      includesMic: input.includesMic ? 1 : 0,
      captureSurface: input.captureSurface?.slice(0, 32) ?? null,
      recorderId: input.recorderId,
      status: "recording",
      startedAt: now,
    })
    .returning();
  return row;
}

/**
 * Hand a session to a new recorder — a resumed tab, or "Continue recording" after Stop.
 *
 * Swaps the recorder id, so the old tab (if it is somehow still alive) is locked out with a
 * 409 rather than interleaving its audio into the same transcript.
 */
export async function resumeMeetingSessionRow(
  userId: string,
  sessionId: string,
  recorderId: string,
): Promise<{ ok: true; session: MeetingSessionRow } | { ok: false; error: string }> {
  const session = await getMeetingSession(userId, sessionId);
  if (!session) return { ok: false, error: "That meeting no longer exists" };
  if (session.status === "saved" || session.status === "discarded") {
    return { ok: false, error: "That meeting was already saved" };
  }
  const db = await getDb();
  const [row] = await db
    .update(meetingSessions)
    .set({
      status: "recording",
      recorderId,
      endedAt: null,
      // A resumed recording changes the transcript, so an earlier analysis is stale.
      digest: null,
      digestError: null,
      updatedAt: new Date(),
    })
    .where(eq(meetingSessions.id, session.id))
    .returning();
  return { ok: true, session: row };
}

export async function endMeetingSessionRow(
  userId: string,
  sessionId: string,
  input: { durationMs?: number } = {},
): Promise<MeetingSessionRow | null> {
  const session = await getMeetingSession(userId, sessionId);
  if (!session) return null;
  if (session.status !== "recording") return session;
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .update(meetingSessions)
    .set({
      status: "ended",
      endedAt: now,
      updatedAt: now,
      recorderId: null,
      durationMs: Math.max(session.durationMs, Math.round(input.durationMs ?? 0)),
    })
    .where(eq(meetingSessions.id, session.id))
    .returning();
  return row;
}

export async function updateMeetingDetails(
  userId: string,
  sessionId: string,
  input: { title?: string | null; attendees?: MeetingAttendee[] },
): Promise<MeetingSessionRow | null> {
  const session = await getMeetingSession(userId, sessionId);
  if (!session) return null;
  const db = await getDb();
  const [row] = await db
    .update(meetingSessions)
    .set({
      ...(input.title !== undefined ? { title: cleanTitle(input.title) } : {}),
      ...(input.attendees !== undefined ? { attendees: cleanAttendees(input.attendees) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(meetingSessions.id, session.id))
    .returning();
  return row;
}

export async function storeMeetingDigest(
  userId: string,
  sessionId: string,
  outcome: { digest: MeetingDigest } | { error: string },
): Promise<void> {
  const db = await getDb();
  await db
    .update(meetingSessions)
    .set(
      "digest" in outcome
        ? { digest: outcome.digest, digestError: null, status: "analyzed", updatedAt: new Date() }
        : { digestError: outcome.error.slice(0, 500), updatedAt: new Date() },
    )
    .where(and(eq(meetingSessions.id, sessionId), eq(meetingSessions.userId, userId)));
}

export async function markMeetingSessionSaved(
  userId: string,
  sessionId: string,
  noteBatchId: string,
): Promise<void> {
  const db = await getDb();
  await db
    .update(meetingSessions)
    .set({ status: "saved", noteBatchId, recorderId: null, updatedAt: new Date() })
    .where(and(eq(meetingSessions.id, sessionId), eq(meetingSessions.userId, userId)));
}

/**
 * Throw a meeting away: the session and every line of its transcript.
 *
 * Deleted, not flagged. A discarded recording is one the user decided should not exist,
 * and a transcript is other people's words verbatim — there is no reason to keep it.
 * Segments go explicitly rather than by cascade, for the reason `purgeUserData` gives.
 */
export async function discardMeetingSessionRow(userId: string, sessionId: string): Promise<boolean> {
  const session = await getMeetingSession(userId, sessionId);
  if (!session) return false;
  const db = await getDb();
  await db
    .delete(meetingTranscriptSegments)
    .where(
      and(
        eq(meetingTranscriptSegments.sessionId, session.id),
        eq(meetingTranscriptSegments.userId, userId),
      ),
    );
  await db.delete(meetingSessions).where(eq(meetingSessions.id, session.id));
  return true;
}

export type ResumableMeeting = {
  id: string;
  title: string | null;
  status: MeetingSessionStatus;
  startedAtIso: string;
  durationMs: number;
  segmentCount: number;
  lastSeq: number;
  hasDigest: boolean;
  includesMic: boolean;
  attendees: MeetingAttendee[];
};

/** The newest unfinished meeting, for the capture page's resume banner. */
export async function getResumableMeeting(userId: string): Promise<ResumableMeeting | null> {
  const db = await getDb();
  const since = new Date(Date.now() - RESUMABLE_WINDOW_DAYS * 86_400_000);
  const session = await db.query.meetingSessions.findFirst({
    where: and(
      eq(meetingSessions.userId, userId),
      inArray(meetingSessions.status, UNFINISHED),
      gte(meetingSessions.updatedAt, since),
    ),
    orderBy: [desc(meetingSessions.updatedAt)],
  });
  if (!session) return null;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(meetingTranscriptSegments)
    .where(eq(meetingTranscriptSegments.sessionId, session.id));
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    startedAtIso: session.startedAt.toISOString(),
    durationMs: session.durationMs,
    segmentCount: Number(count) || 0,
    lastSeq: session.lastSeq,
    hasDigest: Boolean(session.digest),
    includesMic: session.includesMic === 1,
    attendees: session.attendees ?? [],
  };
}

async function sweepAbandonedSessions(userId: string, now: Date) {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - ABANDONED_SESSION_TTL_DAYS * 86_400_000);
  const stale = await db
    .select({ id: meetingSessions.id })
    .from(meetingSessions)
    .where(
      and(
        eq(meetingSessions.userId, userId),
        or(
          eq(meetingSessions.status, "discarded"),
          and(inArray(meetingSessions.status, UNFINISHED), lt(meetingSessions.updatedAt, cutoff)),
        ),
      ),
    );
  if (!stale.length) return;
  const ids = stale.map((s) => s.id);
  await db.delete(meetingTranscriptSegments).where(inArray(meetingTranscriptSegments.sessionId, ids));
  await db.delete(meetingSessions).where(inArray(meetingSessions.id, ids));
}

// ── Segments ──────────────────────────────────────────────────────────────────────────

export type ChunkMeta = {
  seq: number;
  startMs: number;
  endMs: number;
  recorderId: string | null;
};

export type IngestChunkResult =
  | {
      ok: true;
      seq: number;
      text: string;
      engine: MeetingSegmentEngine;
      /** True when this seq was already stored and nothing was transcribed. */
      duplicate: boolean;
    }
  | { ok: false; status: 400 | 404 | 409 | 410; error: string };

/** A chunk this far past the start is not a real recording. Three hours plus slack. */
const MAX_CHUNK_OFFSET_MS = 4 * 60 * 60_000;
const MAX_SEQ = 10_000;

export function validateChunkMeta(meta: ChunkMeta): string | null {
  const { seq, startMs, endMs } = meta;
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return "Bad chunk number";
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "Bad chunk timing";
  if (startMs < 0 || endMs < startMs || endMs > MAX_CHUNK_OFFSET_MS) return "Bad chunk timing";
  return null;
}

/**
 * Store one chunk of a meeting: transcribe it (unless this seq is already stored) and
 * write the text.
 *
 * `wav === null` is a chunk the recorder measured as silent. It is still recorded — as an
 * empty `silent` segment — so the transcript's timeline has no unexplained holes and the
 * seq numbering stays dense, but it costs no transcription call.
 */
export async function ingestMeetingChunk(
  userId: string,
  sessionId: string,
  meta: ChunkMeta,
  wav: Uint8Array | null,
  transcribe: Transcriber = defaultTranscriber,
): Promise<IngestChunkResult> {
  const invalid = validateChunkMeta(meta);
  if (invalid) return { ok: false, status: 400, error: invalid };

  const session = await getMeetingSession(userId, sessionId);
  if (!session) return { ok: false, status: 404, error: "Meeting not found" };

  const db = await getDb();
  const existing = await findSegment(session.id, meta.seq);
  if (existing) {
    return { ok: true, seq: existing.seq, text: existing.text, engine: existing.engine, duplicate: true };
  }

  if (!ACCEPTS_CHUNKS.includes(session.status)) {
    return { ok: false, status: 410, error: "This meeting is no longer recording" };
  }
  // Only the live recorder may write while recording. Once ended, any tab may drain its
  // outbox — the recorder id is cleared on end, and by then there is no audio to interleave.
  if (session.status === "recording" && session.recorderId && meta.recorderId !== session.recorderId) {
    return { ok: false, status: 409, error: "Another tab is recording this meeting" };
  }

  let text = "";
  let engine: MeetingSegmentEngine = "silent";
  if (wav && wav.byteLength > 0) {
    const previous = await findSegment(session.id, meta.seq - 1);
    const result = await transcribe(
      userId,
      {
        mimeType: "audio/wav",
        base64: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString("base64"),
        filename: `meeting-${meta.seq}.wav`,
      },
      { contextText: previous?.text ?? null, allowEmpty: true, operation: "meeting.transcribe" },
    );
    text = result.text.trim();
    engine = result.engine;
  }

  const inserted = await db
    .insert(meetingTranscriptSegments)
    .values({
      sessionId: session.id,
      userId,
      seq: meta.seq,
      startMs: Math.round(meta.startMs),
      endMs: Math.round(meta.endMs),
      text,
      engine,
    })
    .onConflictDoNothing({
      target: [meetingTranscriptSegments.sessionId, meetingTranscriptSegments.seq],
    })
    .returning();

  if (!inserted.length) {
    // Lost a race with a concurrent upload of the same seq. Theirs is the stored truth.
    const winner = await findSegment(session.id, meta.seq);
    if (winner) {
      return { ok: true, seq: winner.seq, text: winner.text, engine: winner.engine, duplicate: true };
    }
  }

  await db
    .update(meetingSessions)
    .set({
      lastSeq: sql`greatest(${meetingSessions.lastSeq}, ${meta.seq})`,
      durationMs: sql`greatest(${meetingSessions.durationMs}, ${Math.round(meta.endMs)})`,
      updatedAt: new Date(),
    })
    .where(eq(meetingSessions.id, session.id));

  return { ok: true, seq: meta.seq, text, engine, duplicate: false };
}

async function findSegment(sessionId: string, seq: number): Promise<MeetingSegmentRow | null> {
  if (seq < 0) return null;
  const db = await getDb();
  const row = await db.query.meetingTranscriptSegments.findFirst({
    where: and(
      eq(meetingTranscriptSegments.sessionId, sessionId),
      eq(meetingTranscriptSegments.seq, seq),
    ),
  });
  return row ?? null;
}

export type MeetingTranscript = {
  session: MeetingSessionRow;
  segments: Pick<MeetingSegmentRow, "seq" | "startMs" | "endMs" | "text" | "engine">[];
  /** The spoken text only, in order, one paragraph per chunk. What the analysis reads. */
  text: string;
  /** Seqs missing from 0..lastSeq — chunks that never arrived. */
  missingSeqs: number[];
};

export async function getMeetingTranscript(
  userId: string,
  sessionId: string,
): Promise<MeetingTranscript | null> {
  const session = await getMeetingSession(userId, sessionId);
  if (!session) return null;
  const db = await getDb();
  const segments = await db
    .select({
      seq: meetingTranscriptSegments.seq,
      startMs: meetingTranscriptSegments.startMs,
      endMs: meetingTranscriptSegments.endMs,
      text: meetingTranscriptSegments.text,
      engine: meetingTranscriptSegments.engine,
    })
    .from(meetingTranscriptSegments)
    .where(eq(meetingTranscriptSegments.sessionId, session.id))
    .orderBy(asc(meetingTranscriptSegments.seq));
  return {
    session,
    segments,
    text: assembleTranscriptText(segments),
    missingSeqs: missingSeqs(segments.map((s) => s.seq), session.lastSeq),
  };
}

/** Pure: segments (any order) → the transcript text. Exported for the smoke test. */
export function assembleTranscriptText(segments: { seq: number; text: string }[]): string {
  return [...segments]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function missingSeqs(present: number[], lastSeq: number): number[] {
  const have = new Set(present);
  const out: number[] = [];
  for (let i = 0; i <= lastSeq; i++) if (!have.has(i)) out.push(i);
  return out;
}

// ── Saving ────────────────────────────────────────────────────────────────────────────

/** The results-page snapshot of a meeting, taken from its stored digest. */
export function toNoteBatchMeeting(session: MeetingSessionRow): NoteBatchMeeting {
  const digest = session.digest;
  if (!digest) throw new Error("Analyze the meeting before saving it");
  return {
    sessionId: session.id,
    title: session.title || digest.title,
    summary: digest.summary,
    keyPoints: digest.keyPoints,
    decisions: digest.decisions,
    actionItems: digest.actionItems.map((a) => ({ text: a.text, owner: a.owner })),
    blockers: digest.blockers.map((b) => ({ text: b.text, owner: b.owner })),
    openQuestions: digest.openQuestions.map((q) => ({ text: q.text, askedBy: q.askedBy })),
    durationMs: session.durationMs,
    startedAtIso: session.startedAt.toISOString(),
  };
}

export async function getNoteBatchForUser(userId: string, batchId: string) {
  const db = await getDb();
  const row = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId)),
  });
  return row ?? null;
}

/** Who "I" is on a recording — so the user is never offered as a contact from their own call. */
export async function loadMeetingSelf(
  userId: string,
): Promise<{ firstName: string | null; lastName: string | null }> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { firstName: true, lastName: true },
  });
  return { firstName: row?.firstName ?? null, lastName: row?.lastName ?? null };
}

// ── Input hygiene ─────────────────────────────────────────────────────────────────────

function cleanTitle(title: string | null | undefined): string | null {
  const t = title?.replace(/\s+/g, " ").trim().slice(0, 200);
  return t || null;
}

function cleanAttendees(attendees: MeetingAttendee[] | undefined): MeetingAttendee[] {
  const seen = new Set<string>();
  const out: MeetingAttendee[] = [];
  for (const a of attendees ?? []) {
    const name = a.name?.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const email = a.email?.trim().slice(0, 254) || null;
    out.push(email ? { name, email } : { name });
    if (out.length >= 50) break;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres rejects a malformed uuid with an error; a bad id from a URL is a 404, not a 500. */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}
