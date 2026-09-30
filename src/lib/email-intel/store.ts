/**
 * Writes for the email-insights sweep. Idempotent by construction: the thread row is keyed
 * on (user, provider, thread) and only rewritten when its last message id changed, and the
 * rule event is keyed on (thread, kind) so a stage that moves updates one row in place.
 * neon-http has no transactions, so each statement stands alone and is safe to repeat.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailEvents, emailThreads, userSettings } from "@/db/schema";
import { statusFor, type ThreadResult } from "./types";

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
    .returning({ id: emailThreads.id });
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
