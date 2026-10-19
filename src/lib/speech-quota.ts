/**
 * How many Deepgram seconds this account has left this month, and the recording of what it
 * spent.
 *
 * A meeting is ONE row that grows: segments arrive every few seconds and each carries the
 * meeting's audio position, so the row holds a high-water mark rather than a running sum. A
 * browser that dies mid-meeting therefore still counts the audio it used, and a retried
 * segment batch never double-charges. Voice notes get their own row each.
 */
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { speechUsage } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { limitFor, monthWindow, quotaState, type SpeechKind } from "@/lib/speech-limits";
import { MAX_SESSION_MS } from "@/lib/dictation";

export type SpeechAllowance = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: Date;
  warn: boolean;
  exhausted: boolean;
};

/**
 * This month's allowance for one meter.
 *
 * `cache()`d per render: /settings asks for the short-form meter twice (once itself, once
 * inside `getAiAccessStatus`), and both arguments are primitives, so the two share one
 * read. In Server Actions and route handlers — the only places speech is recorded —
 * `cache()` is a pass-through, so a check made after a write there always reads fresh.
 */
export const speechAllowance = cache(async function speechAllowance(
  userId: string,
  kind: SpeechKind
): Promise<SpeechAllowance> {
  const [db, entitlements] = await Promise.all([getDb(), getEntitlements(userId)]);
  const { start, resetsAt } = monthWindow(new Date());
  const rows = await db
    .select({ used: sql<number>`coalesce(sum(${speechUsage.seconds}), 0)` })
    .from(speechUsage)
    .where(
      and(
        eq(speechUsage.userId, userId),
        eq(speechUsage.kind, kind),
        gte(speechUsage.createdAt, start),
      ),
    );
  const used = Number(rows[0]?.used ?? 0);
  const limit = limitFor(kind, entitlements.plan);
  return { limit, used, resetsAt, ...quotaState(used, limit) };
});

export async function recordSpeechSeconds(input: {
  userId: string;
  kind: SpeechKind;
  seconds: number;
  source: "stream" | "file";
  sessionId?: string | null;
  requestId?: string | null;
}): Promise<void> {
  const seconds = Math.max(0, Math.round(input.seconds));
  if (!seconds) return;
  const db = await getDb();
  if (!input.sessionId) {
    await db.insert(speechUsage).values({
      userId: input.userId,
      kind: input.kind,
      seconds,
      source: input.source,
      requestId: input.requestId ?? null,
    });
    return;
  }
  await db
    .insert(speechUsage)
    .values({
      userId: input.userId,
      kind: input.kind,
      seconds,
      source: input.source,
      sessionId: input.sessionId,
      requestId: input.requestId ?? null,
    })
    .onConflictDoUpdate({
      target: speechUsage.sessionId,
      // A high-water mark, not a sum: every report carries the meeting's total so far.
      set: { seconds: sql`greatest(${speechUsage.seconds}, ${seconds})` },
    });
}

// ── Chat-mic grants: server-side session accounting (audit M-18) ────────────────────────

/**
 * Marks a `speech_usage` row as a chat-mic token's provisional charge (`request_id`), and
 * the same row once the client's end beacon has settled it. `request_id` otherwise holds a
 * Deepgram request id, which never takes either shape.
 */
export const DICTATION_GRANT_PENDING = "dictation-grant";
export const DICTATION_GRANT_SETTLED = "dictation-grant:settled";

/** One dictation session's ceiling, in seconds (`MAX_SESSION_MS`, the client's own stop). */
export const DICTATION_SESSION_SECONDS = Math.round(MAX_SESSION_MS / 1000);

/** A beacon without grant ids (a tab loaded before this shipped) settles a grant this recent. */
const LEGACY_SETTLE_WINDOW_MS = 15 * 60 * 1000;

const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Charge one minted chat-mic token a full session up front.
 *
 * The chat mic's seconds used to reach `speech_usage` only from the browser's end beacon, so
 * a blocked or tampered beacon was free dictation until the nightly reconciliation noticed.
 * Now each token is charged `DICTATION_SESSION_SECONDS` the moment it is minted, against the
 * same monthly allowance the mint checks, and the beacon can only LOWER that to what the
 * session streamed. A lost beacon over-counts one session — the safe direction. Returns the
 * grant id the browser sends back.
 */
export async function chargeDictationGrant(userId: string): Promise<string> {
  const grantId = randomUUID();
  const db = await getDb();
  await db.insert(speechUsage).values({
    userId,
    kind: "shortform",
    seconds: DICTATION_SESSION_SECONDS,
    source: "stream",
    sessionId: grantId,
    requestId: DICTATION_GRANT_PENDING,
  });
  return grantId;
}

/** Undo a charge whose token never reached the browser (the mint itself failed). */
export async function voidDictationGrant(userId: string, grantId: string): Promise<void> {
  const db = await getDb();
  await db
    .delete(speechUsage)
    .where(
      and(
        eq(speechUsage.userId, userId),
        eq(speechUsage.sessionId, grantId),
        eq(speechUsage.requestId, DICTATION_GRANT_PENDING)
      )
    );
}

/**
 * The end beacon: lower this session's pending grants to the seconds it reports.
 *
 * A session that reconnected minted several tokens and reports ONE total, so the total is
 * spread over its grants oldest first, each capped at what it was charged — the sum can only
 * go down, never past one session. Each grant settles once; a replayed beacon finds nothing
 * pending. Grant ids that are not this account's, or not pending, are ignored.
 *
 * With no grant ids (a tab that loaded before grants existed) the newest pending grant of the
 * last fifteen minutes is settled; when there is none, the seconds are recorded the old way.
 */
export async function settleDictationGrants(
  userId: string,
  grantIds: string[],
  reportedSeconds: number
): Promise<{ settled: number }> {
  const db = await getDb();
  let total = Math.max(0, Math.min(DICTATION_SESSION_SECONDS, Math.round(reportedSeconds)));
  const ids = grantIds.filter((id) => GRANT_ID.test(id)).slice(0, 20);

  const pending = ids.length
    ? and(
        eq(speechUsage.userId, userId),
        eq(speechUsage.requestId, DICTATION_GRANT_PENDING),
        inArray(speechUsage.sessionId, ids)
      )
    : and(
        eq(speechUsage.userId, userId),
        eq(speechUsage.requestId, DICTATION_GRANT_PENDING),
        gte(speechUsage.createdAt, new Date(Date.now() - LEGACY_SETTLE_WINDOW_MS))
      );
  const rows = await db
    .select({ id: speechUsage.id, seconds: speechUsage.seconds })
    .from(speechUsage)
    .where(pending)
    .orderBy(ids.length ? asc(speechUsage.createdAt) : desc(speechUsage.createdAt))
    .limit(ids.length ? 20 : 1);

  if (!rows.length) {
    // Nothing was charged up front for this session (a pre-grant tab): record what it reports.
    if (!ids.length) await recordSpeechSeconds({ userId, kind: "shortform", seconds: total, source: "stream" });
    return { settled: 0 };
  }

  let settled = 0;
  for (const row of rows) {
    const seconds = Math.min(row.seconds, total);
    total -= seconds;
    // Guarded on still-pending, so two beacons racing settle each grant once.
    const done = await db
      .update(speechUsage)
      .set({ seconds, requestId: DICTATION_GRANT_SETTLED })
      .where(and(eq(speechUsage.id, row.id), eq(speechUsage.requestId, DICTATION_GRANT_PENDING)))
      .returning();
    settled += done.length;
  }
  return { settled };
}
