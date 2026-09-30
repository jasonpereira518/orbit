/**
 * Events read from the user's mail, as Radar signals.
 *
 * `email_events` (P1/P2) says what an email meant; `rankEventContacts` (P3) says who in the
 * network is worth reaching because of it. This joins the two into `email_event` signals and
 * leaves every decision about what card that becomes, and how much it is worth, to the scorer
 * (`emailCardFor` in `score.ts`), so the rules live once.
 *
 * ## Consent and cost
 *
 * The opt-in check is part of the one statement that reads the events, so an account that has
 * not opted in costs Radar one statement and nothing else. For one that has, ranking is at
 * most `EMAIL_EVENTS_PER_RUN` events, each a handful of batched reads, inside a wall-clock
 * budget; whatever is not reached this run is reached tomorrow.
 *
 * ## What is left out
 *
 * Dismissed events, events older than the window, events of kind `other`, and any event whose
 * summary, company or role trips the injection detector: those strings are model-written from
 * someone else's mail and end up on a card, so a suspicious one is dropped rather than shown.
 * Never a quote, an address, or a message: the signal carries the summary and nothing else
 * from the mail.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { cleanSingleLine, detectInjectionSignals } from "@/lib/ai-security";
import { loadRankContext, rankEventContacts, type RankableEvent } from "@/lib/email-intel/rank";
import type { EmailEventPerson } from "@/lib/email-intel/types";
import { emailCardFor } from "@/lib/radar/score";
import type { RadarSignal } from "@/lib/radar/types";

type EmailEventSignal = Extract<RadarSignal, { kind: "email_event" }>;

const DAY_MS = 86_400_000;
/** Events considered per run, newest first. */
export const EMAIL_EVENTS_PER_RUN = 20;
/** People named per event. */
export const EMAIL_RANK_PER_EVENT = 3;
/** The furthest back an event can still matter (the longest window in `RADAR_WINDOWS`). */
export const EMAIL_LOOKBACK_DAYS = 21;
/** Wall-clock budget for ranking, so a slow network never costs the run its list. */
export const EMAIL_PRODUCER_BUDGET_MS = 8_000;

type EventRow = {
  id: string;
  kind: "job_posting" | "process_update" | "news" | "event";
  company: string | null;
  role: string | null;
  stage: string | null;
  occurred_at: string | Date;
  summary: string;
  people: EmailEventPerson[] | null;
  asks: string[] | null;
  thread_row_id: string | null;
};

function suspicious(...values: Array<string | null>): boolean {
  return values.some((v) => v !== null && detectInjectionSignals(v).length > 0);
}

export async function produceEmailSignals(
  userId: string,
  now: Date,
  deps: { deadline?: number; rank?: typeof rankEventContacts } = {}
): Promise<RadarSignal[]> {
  const db = await getDb();
  const rows = rowsOf<EventRow>(
    await db.execute(sql`
      SELECT e.id, e.kind, e.company, e.role, e.stage, e.occurred_at, e.summary, e.people, e.asks, e.thread_row_id
        FROM email_events e
        JOIN user_settings s ON s.user_id = e.user_id AND s.email_intel_enabled = 1
       WHERE e.user_id = ${userId}
         AND e.dismissed_at IS NULL
         AND e.kind <> 'other'
         AND e.occurred_at >= ${new Date(now.getTime() - EMAIL_LOOKBACK_DAYS * DAY_MS)}
       ORDER BY e.occurred_at DESC, e.id
       LIMIT ${EMAIL_EVENTS_PER_RUN}
    `)
  );
  if (rows.length === 0) return [];

  const rank = deps.rank ?? rankEventContacts;
  const deadline = deps.deadline ?? Date.now() + EMAIL_PRODUCER_BUDGET_MS;
  const context = await loadRankContext(userId);
  const best = new Map<string, EmailEventSignal>();

  for (const row of rows) {
    if (Date.now() >= deadline) break;
    const text = cleanSingleLine(row.summary, 200);
    const company = cleanSingleLine(row.company, 80);
    const role = cleanSingleLine(row.role, 80);
    if (!text || suspicious(text, company, role)) continue;

    const event: RankableEvent = {
      kind: row.kind,
      company,
      role,
      people: row.people ?? [],
      threadRowId: row.thread_row_id,
    };
    const ranked = await rank(userId, event, { limit: EMAIL_RANK_PER_EVENT, context });
    const occurredAt = new Date(row.occurred_at);
    for (const r of ranked) {
      const onThread = r.via.includes("thread");
      const signal: EmailEventSignal = {
        kind: "email_event",
        contactId: r.contactId,
        at: occurredAt,
        eventId: row.id,
        eventKind: row.kind,
        stage: row.stage,
        text,
        company,
        why: cleanSingleLine(r.reasons[0]?.label, 100) ?? "",
        onThread,
        hasAsk: onThread && (row.asks?.length ?? 0) > 0,
        fit: Math.max(0, Math.min(1, r.score / 100)),
      };
      const card = emailCardFor(signal, now);
      if (!card) continue;
      // One signal per person and kind of card: two job postings at one company must not
      // double the points for the same opportunity. The better match wins, then the newer.
      const key = `${r.contactId}:${card.kind}`;
      const prev = best.get(key);
      if (!prev || signal.fit > prev.fit || (signal.fit === prev.fit && signal.at > prev.at)) best.set(key, signal);
    }
  }
  return [...best.values()];
}
