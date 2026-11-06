/**
 * Writes for the email-insights sweep. Idempotent by construction: the thread row is keyed
 * on (user, provider, thread) and only rewritten when its last message id changed, and the
 * rule event is keyed on (thread, kind) so a stage that moves updates one row in place.
 * neon-http has no transactions, so each statement stands alone and is safe to repeat.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { emailEvents, emailThreads, userSettings } from "@/db/schema";
import { statusFor, type ExtractedEvent, type ThreadResult } from "./types";

export async function upsertThreadResult(userId: string, result: ThreadResult): Promise<{ changed: boolean }> {
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .insert(emailThreads)
    .values({
      userId,
      provider: "gmail",
      threadId: result.threadId,
      lastMessageId: result.lastMessageId,
      subject: result.subject,
      participants: result.participants,
      lastDirection: result.lastDirection,
      decision: result.decision,
      triageScore: result.triageScore,
      status: statusFor(result.decision),
      processedAt: now,
    })
    .onConflictDoUpdate({
      target: [emailThreads.userId, emailThreads.provider, emailThreads.threadId],
      set: {
        lastMessageId: result.lastMessageId,
        subject: result.subject,
        participants: result.participants,
        lastDirection: result.lastDirection,
        decision: result.decision,
        triageScore: result.triageScore,
        status: statusFor(result.decision),
        claimToken: null,
        claimedAt: null,
        processedAt: now,
        updatedAt: now,
      },
      // Untouched when nothing new arrived: the row (and its event) stay exactly as they were.
      setWhere: sql`${emailThreads.lastMessageId} <> excluded.last_message_id`,
    })
    // Bare `.returning()`: a field selector defeats Drizzle's overload resolution after
    // `.onConflictDoUpdate()` against the union `Db` type (see contact-identity.ts).
    .returning();
  if (!row) return { changed: false };

  if (result.event) {
    const e = result.event;
    await db
      .insert(emailEvents)
      .values({
        userId,
        threadRowId: row.id,
        source: "rule",
        kind: e.kind,
        company: e.company,
        stage: e.stage,
        occurredAt: e.occurredAt,
        summary: e.summary,
        evidenceQuote: e.evidenceQuote,
        confidence: e.confidence,
      })
      .onConflictDoUpdate({
        target: [emailEvents.threadRowId, emailEvents.kind],
        targetWhere: sql`source = 'rule'`,
        set: {
          company: e.company,
          stage: e.stage,
          occurredAt: e.occurredAt,
          summary: e.summary,
          evidenceQuote: e.evidenceQuote,
          confidence: e.confidence,
          updatedAt: now,
        },
      });
  } else {
    // The thread no longer reads as an event (it went quiet, or became irrelevant).
    await db.delete(emailEvents).where(and(eq(emailEvents.threadRowId, row.id), eq(emailEvents.source, "rule")));
  }
  return { changed: true };
}

export async function knownThreadVersions(userId: string, threadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (threadIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ threadId: emailThreads.threadId, lastMessageId: emailThreads.lastMessageId })
    .from(emailThreads)
    .where(and(eq(emailThreads.userId, userId), inArray(emailThreads.threadId, threadIds)));
  for (const r of rows) out.set(r.threadId, r.lastMessageId);
  return out;
}

/** Everything the feature recorded for one account, and the switch itself. */
export async function deleteEmailIntelData(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(emailEvents).where(eq(emailEvents.userId, userId));
  await db.delete(emailThreads).where(eq(emailThreads.userId, userId));
  await db
    .update(userSettings)
    .set({ emailIntelEnabled: 0, emailIntelCursorAt: null, emailIntelNextAt: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/** A claim older than this belongs to a runner that died; the next run takes the thread back. */
export const CLAIM_LEASE_MS = 10 * 60_000;
/** Counted attempts (a dead runner, an unreadable thread, a model answer that was not JSON). */
export const MAX_STALL_RESUMES = 3;

export type ClaimedThread = {
  id: string;
  threadId: string;
  subject: string;
  participants: string[];
  claimToken: string;
};

/**
 * Claims whose runner died. Back to waiting with one more stall counted; the third stall is
 * a failure, so a thread that keeps killing its runner cannot loop forever.
 */
export async function recoverStalledClaims(now: Date): Promise<number> {
  const db = await getDb();
  const stale = new Date(now.getTime() - CLAIM_LEASE_MS);
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE email_threads
         SET status = CASE WHEN stall_resumes + 1 >= ${MAX_STALL_RESUMES}::int THEN 'failed' ELSE 'pending_ai' END,
             stall_resumes = stall_resumes + 1,
             claim_token = NULL,
             claimed_at = NULL,
             updated_at = ${now}
       WHERE status = 'claimed' AND claimed_at <= ${stale}
      RETURNING id
    `)
  ).length;
}

/** Opted-in accounts with a claimable thread, the one waiting longest first. */
export async function accountsWithPendingThreads(now: Date, limit: number): Promise<string[]> {
  const db = await getDb();
  return rowsOf<{ user_id: string }>(
    await db.execute(sql`
      SELECT t.user_id
        FROM email_threads t
        JOIN user_settings s ON s.user_id = t.user_id
       WHERE s.email_intel_enabled = 1
         AND t.status = 'pending_ai'
         AND (t.claimed_at IS NULL OR t.claimed_at <= ${now})
       GROUP BY t.user_id
       ORDER BY min(t.processed_at), t.user_id
       LIMIT ${limit}
    `)
  ).map((r) => r.user_id);
}

/**
 * One UPDATE ... RETURNING claims the account's newest waiting threads (neon-http has no
 * transactions). On a `pending_ai` row `claimed_at` is a "not before" time, so a parked thread
 * is skipped until it passes.
 */
export async function claimPendingThreads(userId: string, limit: number, now: Date): Promise<ClaimedThread[]> {
  if (limit <= 0) return [];
  const db = await getDb();
  const token = randomUUID();
  const rows = rowsOf<{ id: string; thread_id: string; subject: string; participants: unknown }>(
    await db.execute(sql`
      UPDATE email_threads
         SET status = 'claimed', claim_token = ${token}::uuid, claimed_at = ${now}, updated_at = ${now}
       WHERE user_id = ${userId}
         AND id IN (
           SELECT id FROM email_threads
            WHERE user_id = ${userId}
              AND status = 'pending_ai'
              AND (claimed_at IS NULL OR claimed_at <= ${now})
            ORDER BY processed_at DESC
            LIMIT ${limit}
         )
      RETURNING id, thread_id, subject, participants
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    subject: r.subject,
    participants: Array.isArray(r.participants) ? (r.participants as string[]) : [],
    claimToken: token,
  }));
}

/**
 * Writes the extraction only while the claim is still held. A newer message resets the thread
 * (`upsertThreadResult` clears the token), so an extraction of the older mail is dropped, not
 * stored against the newer one.
 */
export async function settleExtraction(
  userId: string,
  claim: ClaimedThread,
  events: ExtractedEvent[]
): Promise<boolean> {
  const db = await getDb();
  const held = await db
    .select({ id: emailThreads.id })
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.id, claim.id),
        eq(emailThreads.userId, userId),
        eq(emailThreads.claimToken, claim.claimToken),
        eq(emailThreads.status, "claimed")
      )
    );
  if (held.length === 0) return false;

  await db.delete(emailEvents).where(and(eq(emailEvents.threadRowId, claim.id), eq(emailEvents.source, "ai")));
  if (events.length > 0) {
    await db.insert(emailEvents).values(
      events.map((e) => ({
        userId,
        threadRowId: claim.id,
        source: "ai" as const,
        kind: e.kind,
        company: e.company,
        role: e.role,
        stage: e.stage,
        occurredAt: e.occurredAt,
        dueAt: e.dueAt,
        summary: e.summary,
        evidenceQuote: e.evidenceQuote,
        confidence: e.confidence,
        people: e.people,
        asks: e.asks,
      }))
    );
  }
  const done = await db
    .update(emailThreads)
    .set({ status: "done", claimToken: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(emailThreads.id, claim.id), eq(emailThreads.claimToken, claim.claimToken)))
    .returning();
  return done.length > 0;
}

/**
 * Hands a claim back. `countStall` is for problems with the thread itself (unreadable, a bad
 * answer); a problem with the person's key or allowance is not the thread's fault and is not
 * counted. `notBefore` parks the thread until then.
 */
export async function releaseThread(
  claim: ClaimedThread,
  opts: { notBefore: Date | null; countStall: boolean }
): Promise<void> {
  const db = await getDb();
  const inc = opts.countStall ? 1 : 0;
  await db.execute(sql`
    UPDATE email_threads
       SET status = CASE WHEN ${inc}::int = 1 AND stall_resumes + 1 >= ${MAX_STALL_RESUMES}::int THEN 'failed' ELSE 'pending_ai' END,
           stall_resumes = stall_resumes + ${inc}::int,
           claim_token = NULL,
           claimed_at = ${opts.notBefore},
           updated_at = now()
     WHERE id = ${claim.id}::uuid AND claim_token = ${claim.claimToken}::uuid
  `);
}

/** Parks every waiting thread of an account, so a run does not find it again until `until`. */
export async function deferPending(userId: string, until: Date): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE email_threads SET claimed_at = ${until}
     WHERE user_id = ${userId} AND status = 'pending_ai'
  `);
}
