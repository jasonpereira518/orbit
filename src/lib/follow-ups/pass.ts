import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { followUpSuggestions, followUpWeights } from "@/db/schema";
import { loadScoringInputs, loadSignalContext } from "./context";
import { scoreCandidates, type ScoredSuggestion } from "./score";
import { DAILY_SOURCES } from "./sources";
import { isoDay } from "./time";
import type { SignalCandidate, SignalKind } from "./types";

export type PassResult = {
  /** Candidates emitted by all sources, before filtering. */
  detected: number;
  /** Survivors of the hard filters, capped at the shortlist size. */
  shortlisted: number;
  /** Rows actually written after the daily cap. */
  written: number;
};

/**
 * The rule-generated reason sentence.
 *
 * Phase 2's LLM judge replaces this with something better, but it must always exist:
 * on Vercel a user without their own API key can never run the judge at all, and they
 * still get a full daily list. `evidence` is already a human clause, so the templates
 * frame it rather than restate it.
 */
export function reasonFor(kind: SignalKind, evidence: string): string {
  switch (kind) {
    case "commitment_due":
      return evidence;
    case "scheduled_follow_up":
      return "You set a follow-up for today.";
    case "birthday":
    case "personal_date":
    case "met_anniversary":
    case "work_anniversary":
      return `${evidence}.`;
    case "open_loop":
      return `${evidence} — worth closing the loop.`;
    case "post_event":
      return `${evidence}.`;
    case "thread_quiet":
      return `${evidence}.`;
    case "dormant":
      return `${evidence}.`;
    case "never_contacted":
      return `${evidence} — a first message costs little.`;
    case "job_change":
    case "job_opening":
      return `${evidence}.`;
  }
}

/**
 * One user's daily pass: load, detect, score, cap, write.
 *
 * Writes ONLY to `follow_up_suggestions`. Never to `reminders` — desktop notifications
 * fire off `reminders`, and machine output the user has not accepted must not reach
 * them. Accepting a suggestion is what creates the reminder.
 */
export async function runFollowUpPass(
  userId: string,
  options: { now?: Date } = {}
): Promise<PassResult> {
  const now = options.now ?? new Date();

  const [ctx, scoringInputs] = await Promise.all([
    loadSignalContext(userId, now),
    loadScoringInputs(userId, now),
  ]);

  const candidates: SignalCandidate[] = [];
  for (const source of DAILY_SOURCES) {
    // A single broken source must not cost the user their whole day.
    try {
      candidates.push(...source.detect(ctx));
    } catch (err) {
      console.error(`follow-ups: source ${source.kind} threw`, err);
    }
  }

  const contactsById = new Map(ctx.contacts.map((c) => [c.id, c]));
  const shortlist = scoreCandidates({
    now,
    candidates,
    contactsById,
    suppressions: scoringInputs.suppressions,
    weightsByKind: scoringInputs.weightsByKind,
    contactsWithPendingReminder: ctx.contactsWithPendingReminder,
    contactsWithPendingSuggestion: scoringInputs.contactsWithPendingSuggestion,
  });

  // Phase 2 inserts the LLM judge here, between the shortlist and the cap.
  //
  // The cap bounds the DAY, not the invocation. `ops.yml` says its schedule is a floor,
  // not a promise, so this pass can fire more than once for the same user on the same
  // day — if each run capped independently, a second run would spend a fresh cap's
  // worth of rows on top of what an earlier run already wrote for `today`, and a user
  // with dailyCap 3 could end the day with far more than 3 new cards. Contacts that
  // already have a pending suggestion are excluded upstream by filter 5
  // (`contactsWithPendingSuggestion`), but that only stops the SAME contact from being
  // suggested twice — it does nothing to stop a different, lower-scoring contact from
  // filling the newly-reopened top of the shortlist. Subtracting what is already on the
  // books for `today` closes that gap. `suggestionsWrittenToday` is counted inside
  // `loadScoringInputs` — see `context.ts` — using the same `isoDay(startOfDay(now))`
  // day basis every `dueOn` below is written in, so the two cannot drift apart.
  const remainingCapToday = Math.max(
    0,
    scoringInputs.dailyCap - scoringInputs.suggestionsWrittenToday
  );
  const selected = shortlist.slice(0, remainingCapToday);

  await writeSuggestions(userId, selected);
  await recordShown(userId, selected);

  return {
    detected: candidates.length,
    shortlisted: shortlist.length,
    written: selected.length,
  };
}

async function writeSuggestions(userId: string, selected: ScoredSuggestion[]) {
  if (selected.length === 0) return;
  const db = await getDb();

  await db
    .insert(followUpSuggestions)
    .values(
      selected.map((s) => ({
        userId,
        contactId: s.contactId,
        dueOn: isoDay(s.dueOn),
        primaryKind: s.primaryKind,
        signals: s.signals,
        score: s.score,
        reason: reasonFor(
          s.primaryKind,
          s.signals.find((x) => x.kind === s.primaryKind)?.evidence ?? ""
        ),
        hook: null,
        judged: false,
        status: "pending" as const,
      }))
    )
    // Idempotency. `ops.yml` states its schedule is a floor, not a promise, so the
    // same pass CAN run twice for one user on one day. Re-running refreshes the score
    // and evidence rather than duplicating the card — and deliberately does NOT touch
    // `status`, so a suggestion the user already dismissed stays dismissed.
    .onConflictDoUpdate({
      target: [
        followUpSuggestions.userId,
        followUpSuggestions.contactId,
        followUpSuggestions.primaryKind,
        followUpSuggestions.dueOn,
      ],
      set: {
        signals: sql`excluded.signals`,
        score: sql`excluded.score`,
        reason: sql`excluded.reason`,
      },
    });
}

/** Every surfaced suggestion increments `shown` for its kind — the denominator of the weight. */
async function recordShown(userId: string, selected: ScoredSuggestion[]) {
  if (selected.length === 0) return;
  const db = await getDb();
  const counts = new Map<string, number>();
  for (const s of selected) {
    counts.set(s.primaryKind, (counts.get(s.primaryKind) ?? 0) + 1);
  }
  for (const [kind, n] of counts) {
    await db
      .insert(followUpWeights)
      .values({ userId, kind, shown: n })
      .onConflictDoUpdate({
        target: [followUpWeights.userId, followUpWeights.kind],
        set: {
          shown: sql`${followUpWeights.shown} + ${n}`,
          updatedAt: new Date(),
        },
      });
  }
}
