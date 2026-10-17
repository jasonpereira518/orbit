/**
 * The server half of `speech-cost.ts`: how much of the Deepgram credit is spent, and the gate
 * every Deepgram call site asks before drawing on it.
 *
 * Spend is priced from `speech_usage` — the same seconds the per-account caps meter — so the
 * credit gauge, the Money screen and the ops alerts all read one number. It is an estimate
 * (list price x the opt-out multiplier, browser-reported live seconds); the nightly
 * reconciliation and `cost/reconcile` are what hold it to Deepgram's own figure.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { speechUsage, userSettings } from "@/db/schema";
import { deepgramEnabled } from "@/lib/deepgram";
import { getEntitlements } from "@/lib/entitlements";
import { reportError } from "@/lib/report-error";
import {
  DEEPGRAM_CREDIT,
  creditAllows,
  creditShare,
  speechCostMicros,
  type SpeechSecondsRow,
} from "@/lib/speech-cost";
import type { SpeechKind } from "@/lib/speech-limits";

/** Priced Deepgram spend between two instants, from `speech_usage`. */
export async function speechSpendMicros(since: Date, until?: Date): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({
      kind: speechUsage.kind,
      source: speechUsage.source,
      seconds: sql<string>`coalesce(sum(${speechUsage.seconds}), 0)`,
    })
    .from(speechUsage)
    .where(until ? and(gte(speechUsage.createdAt, since), lt(speechUsage.createdAt, until)) : gte(speechUsage.createdAt, since))
    .groupBy(speechUsage.kind, speechUsage.source);
  return speechCostMicros(
    rows.map((r): SpeechSecondsRow => ({ kind: r.kind, source: r.source, seconds: Number(r.seconds) || 0 })),
  );
}

/**
 * Deepgram spend by live Orbit Pro subscribers since `since`, and how many of them there are —
 * what "contribution per subscriber" on the Money screen has to subtract. A comped, Lifetime
 * or lapsed account is not a Pro subscriber here, matching `resolvePlan`'s precedence.
 */
export async function proSubscriberSpeechSpend(since: Date): Promise<{ micros: number; subscribers: number }> {
  const db = await getDb();
  const livePro = sql`${userSettings.compedPlan} IS NULL AND ${userSettings.lifetimePurchasedAt} IS NULL
    AND ${userSettings.subscriptionPlan} = 'orbit'
    AND (${userSettings.subscriptionStatus} = 'active' OR ${userSettings.subscriptionPeriodEnd} > now())`;
  const [rows, [count]] = await Promise.all([
    db
      .select({
        kind: speechUsage.kind,
        source: speechUsage.source,
        seconds: sql<string>`coalesce(sum(${speechUsage.seconds}), 0)`,
      })
      .from(speechUsage)
      .innerJoin(userSettings, eq(userSettings.userId, speechUsage.userId))
      .where(and(gte(speechUsage.createdAt, since), livePro))
      .groupBy(speechUsage.kind, speechUsage.source),
    db.select({ n: sql<string>`count(*)` }).from(userSettings).where(livePro),
  ]);
  return {
    micros: speechCostMicros(rows.map((r) => ({ kind: r.kind, source: r.source, seconds: Number(r.seconds) || 0 }))),
    subscribers: Number(count?.n ?? 0) || 0,
  };
}

export type SpeechCreditState ={ spentMicros: number; capMicros: number; creditMicros: number; share: number };

// One read per instance per minute. Every Deepgram call site asks, and the answer only moves
// by a few dollars a minute even at scale — the ladder's rungs are percentage points apart.
const CREDIT_TTL_MS = 60_000;
let creditCache: (SpeechCreditState & { at: number }) | null = null;

export async function speechCreditState(now = Date.now()): Promise<SpeechCreditState> {
  if (creditCache && now - creditCache.at < CREDIT_TTL_MS) return creditCache;
  const spentMicros = await speechSpendMicros(new Date(DEEPGRAM_CREDIT.since));
  creditCache = {
    spentMicros,
    capMicros: DEEPGRAM_CREDIT.capMicros,
    creditMicros: DEEPGRAM_CREDIT.creditMicros,
    share: creditShare(spentMicros),
    at: now,
  };
  return creditCache;
}

/** For tests and the admin console: re-read the spend on the next ask. */
export function forgetSpeechCredit() {
  creditCache = null;
}

/** Has this meeting already recorded audio on Deepgram? Then it finishes, whatever the ladder says. */
async function meetingHasAudio(sessionId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ seconds: speechUsage.seconds })
    .from(speechUsage)
    .where(eq(speechUsage.sessionId, sessionId))
    .limit(1);
  return (row?.seconds ?? 0) > 0;
}

/**
 * The question every Deepgram call site asks instead of `deepgramEnabled()`: may THIS account
 * spend Orbit's key on THIS meter now? False routes the call onto exactly the path the kill
 * switch uses (the account's own key, the browser's recogniser), so a rung of the ladder is a
 * degradation and never an outage.
 *
 * FAILS OPEN on a read error. The per-account caps still bound every account, and refusing all
 * transcription because one aggregate read failed would be an outage the credit never asked for.
 */
export async function deepgramOpenFor(
  userId: string,
  kind: SpeechKind,
  opts: { sessionId?: string | null } = {},
): Promise<boolean> {
  if (!deepgramEnabled()) return false;
  let share: number;
  try {
    share = (await speechCreditState()).share;
  } catch (err) {
    reportError(err, { where: "speech-credit.read", level: "warning" });
    return true;
  }
  // Below every rung nothing depends on the plan or the session: skip both reads.
  if (creditAllows({ share, plan: "free", kind })) return true;
  if (kind === "meeting") {
    return opts.sessionId ? meetingHasAudio(opts.sessionId) : false;
  }
  const { plan } = await getEntitlements(userId);
  return creditAllows({ share, plan, kind });
}
