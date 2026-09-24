/**
 * How many Deepgram seconds this account has left this month, and the recording of what it
 * spent.
 *
 * A meeting is ONE row that grows: segments arrive every few seconds and each carries the
 * meeting's audio position, so the row holds a high-water mark rather than a running sum. A
 * browser that dies mid-meeting therefore still counts the audio it used, and a retried
 * segment batch never double-charges. Voice notes get their own row each.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { speechUsage } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { limitFor, monthWindow, quotaState, type SpeechKind } from "@/lib/speech-limits";

export type SpeechAllowance = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: Date;
  warn: boolean;
  exhausted: boolean;
};

export async function speechAllowance(userId: string, kind: SpeechKind): Promise<SpeechAllowance> {
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
}

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
