/**
 * Radar's reads and writes against `recommendations` and `recommendation_feedback`.
 *
 * One run's result is ONE atomic write (`writeRunResult`), so a reader never lands between
 * "old list expired" and "new list inserted" and sees nothing. On neon-http that is one
 * batched request; on PGlite one transaction.
 */
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicWrite, type AtomicStatement } from "@/db";
import { radarRuns, recommendationFeedback, recommendations } from "@/db/schema";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { AI_DERIVED_SOURCE } from "@/lib/interaction-provenance";
import { RADAR_WINDOWS, type RadarPick, type RadarSuppression } from "@/lib/radar/score";
import type {
  RadarDraft,
  RadarAiNote,
  RadarEvidence,
  RadarFeedbackAction,
  RadarReason,
  RecommendationBucket,
  RecommendationKind,
  RecommendationStatus,
} from "@/lib/radar/types";
import { LIVE_RECOMMENDATION_STATUSES, recommendationKey } from "@/lib/radar/types";
import { RADAR_MODEL_HISTORY_DAYS, RADAR_MODEL_VOTES, type RadarModelTallyRow } from "@/lib/radar/model";
import { RADAR_IGNORED_MIN_SEEN } from "@/lib/radar/metrics";

const DAY_MS = 86_400_000;

/** Terminal rows are kept this long as suppression history, then pruned by the run. */
export const RADAR_HISTORY_DAYS = 90;

const LIVE_STATUSES: RecommendationStatus[] = [...LIVE_RECOMMENDATION_STATUSES];
const TERMINAL_STATUSES: RecommendationStatus[] = ["accepted", "dismissed", "expired"];

export type LiveRecommendation = {
  id: string;
  contactId: string;
  kind: RecommendationKind;
  status: RecommendationStatus;
  snoozedUntil: Date | null;
  inputsHash: string;
  aiNote: RadarAiNote | null;
};

export { recommendationKey };

export async function loadLiveRecommendations(userId: string): Promise<LiveRecommendation[]> {
  const db = await getDb();
  return db
    .select({
      id: recommendations.id,
      contactId: recommendations.contactId,
      kind: recommendations.kind,
      status: recommendations.status,
      snoozedUntil: recommendations.snoozedUntil,
      inputsHash: recommendations.inputsHash,
      aiNote: recommendations.aiNote,
    })
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), inArray(recommendations.status, LIVE_STATUSES)));
}

/**
 * What this person already did, per contact: every "never", and the last month of
 * dismissals and accepts. Live snoozes come from the recommendation rows themselves.
 */
export async function loadSuppressions(
  userId: string,
  live: readonly LiveRecommendation[],
  now: Date
): Promise<Map<string, RadarSuppression>> {
  const db = await getDb();
  const since = new Date(now.getTime() - RADAR_WINDOWS.dismissPenalty * DAY_MS);
  const rows = await db
    .select({
      contactId: recommendationFeedback.contactId,
      kind: recommendationFeedback.kind,
      action: recommendationFeedback.action,
      at: sql<Date>`max(${recommendationFeedback.createdAt})`.mapWith(recommendationFeedback.createdAt),
    })
    .from(recommendationFeedback)
    .where(
      and(
        eq(recommendationFeedback.userId, userId),
        or(eq(recommendationFeedback.action, "never"), gte(recommendationFeedback.createdAt, since))
      )
    )
    .groupBy(recommendationFeedback.contactId, recommendationFeedback.kind, recommendationFeedback.action);

  const out = new Map<string, RadarSuppression>();
  const entry = (contactId: string) => {
    let e = out.get(contactId);
    if (!e) {
      e = { never: null, dismissedAt: {}, acceptedAt: {}, snoozedUntil: {} };
      out.set(contactId, e);
    }
    return e;
  };
  for (const r of rows) {
    const e = entry(r.contactId);
    if (r.action === "never") {
      if (r.kind === null) e.never = "all";
      else if (e.never !== "all") e.never = new Set([...(e.never ?? []), r.kind]);
    } else if (r.kind !== null && r.action === "dismissed") {
      e.dismissedAt[r.kind] = r.at;
    } else if (r.kind !== null && r.action === "accepted") {
      e.acceptedAt[r.kind] = r.at;
    }
  }
  for (const rec of live) {
    if (rec.status === "snoozed" && rec.snoozedUntil) entry(rec.contactId).snoozedUntil[rec.kind] = rec.snoozedUntil;
  }
  return out;
}

export type NewRecommendation = RadarPick & { inputsHash: string };

export type WriteCounts = { inserted: number; updated: number; expired: number };

/**
 * What `writeRunResult` will do, computed before it runs: `runAtomicWrite` returns nothing,
 * so the counts cannot come back from the statements themselves.
 */
export function planRunResult(live: readonly LiveRecommendation[], next: readonly NewRecommendation[], now: Date): WriteCounts {
  const nextKeys = new Set(next.map((r) => recommendationKey(r.contactId, r.kind)));
  // Rows the run can expire: pending, and snoozes that have just woken.
  const expirable = new Set(
    live
      .filter((r) => r.status === "pending" || (r.status === "snoozed" && r.snoozedUntil !== null && r.snoozedUntil <= now))
      .map((r) => recommendationKey(r.contactId, r.kind))
  );
  // An autopilot card is updated in place if produced again, and otherwise left to settle.
  const autopiloted = new Set(
    live.filter((r) => r.status === "auto_applied").map((r) => recommendationKey(r.contactId, r.kind))
  );
  let inserted = 0;
  let updated = 0;
  for (const key of nextKeys) {
    if (expirable.has(key) || autopiloted.has(key)) updated++;
    else inserted++;
  }
  let expired = 0;
  for (const key of expirable) if (!nextKeys.has(key)) expired++;
  return { inserted, updated, expired };
}

/**
 * Replace this account's live list with the run's result, in one atomic write:
 *
 *   1. wake snoozes that have ended,
 *   2. expire every pending row the run did not produce (including the ones just woken),
 *   3. upsert the run's rows on the live unique index, keeping a live snooze's status and
 *      keeping the AI note while the inputs it was written from are unchanged,
 *   4. prune history older than `RADAR_HISTORY_DAYS`.
 */
export async function writeRunResult(
  userId: string,
  runId: string,
  next: readonly NewRecommendation[],
  now: Date
): Promise<void> {
  const db = await getDb();
  const keys = next.map((r) => recommendationKey(r.contactId, r.kind));
  const historyCutoff = new Date(now.getTime() - RADAR_HISTORY_DAYS * DAY_MS);
  await runAtomicWrite(db, (tx) => {
    const statements: AtomicStatement[] = [
      tx
        .update(recommendations)
        .set({ status: "pending", snoozedUntil: null, updatedAt: now })
        .where(
          and(
            eq(recommendations.userId, userId),
            eq(recommendations.status, "snoozed"),
            lte(recommendations.snoozedUntil, now)
          )
        ),
      // Retire what this run did not produce, and in the same statement settle autopilot
      // cards whose time has passed: those end `accepted` (the follow-up autopilot set
      // stands) and leave the "Autopilot did this" strip; pending ones end `expired`.
      tx
        .update(recommendations)
        .set({
          status: sql`CASE WHEN ${recommendations.status} = 'auto_applied' THEN 'accepted' ELSE 'expired' END`,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(recommendations.userId, userId),
            or(
              and(
                eq(recommendations.status, "pending"),
                keys.length
                  ? sql`NOT ((${recommendations.contactId}::text || ':' || ${recommendations.kind}) = ANY(ARRAY[${sql.join(
                      keys.map((k) => sql`${k}`),
                      sql`, `
                    )}]::text[]))`
                  : undefined
              ),
              and(eq(recommendations.status, "auto_applied"), lte(recommendations.expiresAt, now))
            )
          )
        ),
    ];
    if (next.length) {
      statements.push(
        tx
          .insert(recommendations)
          .values(
            next.map((r) => ({
              userId,
              contactId: r.contactId,
              kind: r.kind,
              score: r.score,
              baseScore: r.baseScore,
              aiDelta: r.aiDelta ?? null,
              aiAngle: r.aiAngle ?? null,
              bucket: r.bucket,
              reasons: r.reasons,
              evidence: r.evidence,
              status: "pending" as const,
              expiresAt: r.expiresAt,
              runId,
              inputsHash: r.inputsHash,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [recommendations.userId, recommendations.contactId, recommendations.kind],
            // Must imply `recommendations_live_v2_uidx`'s predicate, or Postgres finds no
            // arbiter index for the conflict.
            targetWhere: sql`${recommendations.status} in ('pending', 'snoozed', 'auto_applied')`,
            set: {
              score: sql`excluded.score`,
              baseScore: sql`excluded.base_score`,
              aiDelta: sql`excluded.ai_delta`,
              aiAngle: sql`excluded.ai_angle`,
              bucket: sql`excluded.bucket`,
              reasons: sql`excluded.reasons`,
              evidence: sql`excluded.evidence`,
              expiresAt: sql`excluded.expires_at`,
              runId: sql`excluded.run_id`,
              // Every SET expression reads the OLD row, so this compares the stored hash
              // with the new one before the new one is written.
              aiNote: sql`case when ${recommendations.inputsHash} = excluded.inputs_hash then ${recommendations.aiNote} else null end`,
              inputsHash: sql`excluded.inputs_hash`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
      );
    }
    statements.push(
      tx
        .delete(recommendations)
        .where(
          and(
            eq(recommendations.userId, userId),
            inArray(recommendations.status, TERMINAL_STATUSES),
            lt(recommendations.updatedAt, historyCutoff)
          )
        ),
      tx.delete(radarRuns).where(and(eq(radarRuns.userId, userId), lt(radarRuns.startedAt, historyCutoff)))
    );
    return statements;
  });
}

export async function recordFeedback(
  userId: string,
  entry: { contactId: string; recommendationId: string | null; kind: RecommendationKind | null; action: RadarFeedbackAction; reason?: string | null }
) {
  const db = await getDb();
  await db.insert(recommendationFeedback).values({
    userId,
    contactId: entry.contactId,
    recommendationId: entry.recommendationId,
    kind: entry.kind,
    action: entry.action,
    reason: entry.reason ?? null,
  });
}

/** One card's worth of data, joined to the contact in the same statement. */
export type RecommendationRow = {
  id: string;
  contactId: string;
  kind: RecommendationKind;
  score: number;
  bucket: RecommendationBucket;
  reasons: RadarReason[];
  evidence: RadarEvidence[];
  aiNote: RadarAiNote | null;
  /** The AI rerank's one-line "why now", shown when there is no fuller AI note. */
  aiAngle: string | null;
  /** A draft written overnight, only while it still matches the card's facts. */
  draft: RadarDraft | null;
  contactName: string;
  title: string | null;
  company: string | null;
  tier: "inner" | "mid" | "outer" | null;
  avatarUrl: string | null;
  lastInteractionAt: Date | null;
  updatedAt: Date;
};

/**
 * Pending recommendations, best first, joined to their contacts. `limit` bounds the scan;
 * the page asks for the pending cap, the dashboard for four, the bell for a count.
 */
export async function listPendingRecommendations(userId: string, limit: number): Promise<RecommendationRow[]> {
  const db = await getDb();
  const rows = rowsOf<{
    id: string;
    contact_id: string;
    kind: RecommendationKind;
    score: number;
    bucket: RecommendationBucket;
    reasons: RadarReason[];
    evidence: RadarEvidence[];
    ai_note: RadarAiNote | null;
    ai_angle: string | null;
    draft: RadarDraft | null;
    full_name: string;
    preferred_name: string | null;
    title: string | null;
    company: string | null;
    closeness_tier: "inner" | "mid" | "outer" | null;
    avatar_url: string | null;
    last_interaction_at: string | Date | null;
    updated_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT r.id, r.contact_id, r.kind, r.score, r.bucket, r.reasons, r.evidence, r.ai_note, r.ai_angle, r.updated_at,
             CASE WHEN r.draft ->> 'inputsHash' = r.inputs_hash THEN r.draft END AS draft,
             contacts.full_name, contacts.preferred_name, contacts.title, contacts.company,
             contacts.closeness_tier, contacts.last_interaction_at,
             ${clientAvatarUrlSql} AS avatar_url
        FROM recommendations r
        -- Not aliased: clientAvatarUrlSql names the contacts table in full.
        JOIN contacts ON contacts.id = r.contact_id AND contacts.user_id = r.user_id
       WHERE r.user_id = ${userId} AND r.status = 'pending' AND r.expires_at > now()
       ORDER BY r.score DESC, r.id
       LIMIT ${limit}
    `)
  );
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    kind: r.kind,
    score: Number(r.score),
    bucket: r.bucket,
    reasons: r.reasons ?? [],
    evidence: r.evidence ?? [],
    aiNote: r.ai_note,
    aiAngle: r.ai_angle,
    draft: r.draft,
    contactName: (r.preferred_name ?? "").trim() || r.full_name,
    title: r.title,
    company: r.company,
    tier: r.closeness_tier,
    avatarUrl: r.avatar_url,
    lastInteractionAt: r.last_interaction_at ? new Date(r.last_interaction_at) : null,
    updatedAt: new Date(r.updated_at),
  }));
}

/**
 * This account's votes, grouped: per kind and per positive reason code, summed accepts
 * (a conversion counts double) and dismissals (an ignored card counts half), over
 * `RADAR_MODEL_HISTORY_DAYS`. One statement, a few dozen rows at most; `buildRadarModel`
 * turns them into multipliers. Snoozes are neither: a snooze is "not now", not "not this".
 */
export async function loadModelTallies(userId: string, now: Date): Promise<RadarModelTallyRow[]> {
  const db = await getDb();
  const since = new Date(now.getTime() - RADAR_MODEL_HISTORY_DAYS * DAY_MS).toISOString();
  const V = RADAR_MODEL_VOTES;
  const rows = rowsOf<{ scope: "kind" | "reason"; key: string; a: number | string; d: number | string }>(
    await db.execute(sql`
      WITH votes AS (
        SELECT kind, reasons,
               CASE
                 WHEN status IN ('accepted', 'auto_applied') AND outcome_at IS NOT NULL THEN ${V.converted}::numeric
                 -- Autopilot's action is not the person's vote; only what followed it counts.
                 WHEN status = 'accepted' AND NOT EXISTS (
                   SELECT 1 FROM recommendation_feedback f
                    WHERE f.recommendation_id = recommendations.id AND f.reason = 'autopilot'
                 ) THEN ${V.accepted}::numeric
                 ELSE 0
               END AS a,
               CASE
                 WHEN status = 'dismissed' THEN ${V.dismissed}::numeric
                 WHEN status = 'expired' AND acted_at IS NULL AND seen_count >= ${RADAR_IGNORED_MIN_SEEN} THEN ${V.ignored}::numeric
                 ELSE 0
               END AS d
          FROM recommendations
         WHERE user_id = ${userId}
           AND updated_at >= ${since}::timestamptz
           AND status IN ('accepted', 'auto_applied', 'dismissed', 'expired')
      )
      SELECT 'kind' AS scope, kind AS key, sum(a) AS a, sum(d) AS d
        FROM votes
       GROUP BY kind
      UNION ALL
      SELECT 'reason' AS scope, e ->> 'code' AS key, sum(v.a) AS a, sum(v.d) AS d
        FROM votes v, jsonb_array_elements(v.reasons) AS e
       WHERE (e ->> 'points')::numeric > 0
       GROUP BY e ->> 'code'
    `)
  );
  return rows.map((r) => ({ scope: r.scope, key: r.key, a: Number(r.a ?? 0), d: Number(r.d ?? 0) }));
}

/** A card counts as seen again only after this long, so a reload is not a second look. */
export const RADAR_SEEN_DEBOUNCE_MS = 6 * 60 * 60 * 1000;

/**
 * Impressions: stamp the cards a person was just shown. One statement, fired after the
 * response (`after()` in the server action), so it never costs the page. "Ignored" in the
 * metrics means seen at least three times and then expired untouched, which is only
 * meaningful because a burst of reloads counts once.
 */
export async function markRecommendationsSeen(userId: string, ids: readonly string[], now: Date = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const at = now.toISOString();
  const debounceCutoff = new Date(now.getTime() - RADAR_SEEN_DEBOUNCE_MS);
  await db
    .update(recommendations)
    .set({
      seenCount: sql`${recommendations.seenCount} + 1`,
      lastSeenAt: now,
      firstSeenAt: sql`coalesce(${recommendations.firstSeenAt}, ${at}::timestamptz)`,
    })
    .where(
      and(
        eq(recommendations.userId, userId),
        inArray(recommendations.id, [...ids]),
        or(sql`${recommendations.lastSeenAt} is null`, lt(recommendations.lastSeenAt, debounceCutoff))
      )
    );
}

/** A conversation this soon after an accept is what the accept was for. */
export const RADAR_OUTCOME_WINDOW_DAYS = 14;

/**
 * Outcomes: an accepted (or autopilot-applied) card whose contact then had a real
 * interaction within `RADAR_OUTCOME_WINDOW_DAYS` gets `outcome_at`. One statement per run,
 * over the account's recent accepts only. "Real" is `countsAsTouch`: an AI-derived row is
 * not a conversation. Returns how many cards converted this time.
 */
export async function detectRadarOutcomes(userId: string, now: Date): Promise<number> {
  const db = await getDb();
  const at = now.toISOString();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE recommendations r
         SET outcome_at = t.at
        FROM (
          SELECT r2.id, min(i.interaction_date) AS at
            FROM recommendations r2
            JOIN interactions i ON i.user_id = r2.user_id AND i.contact_id = r2.contact_id
           WHERE r2.user_id = ${userId}
             AND r2.status IN ('accepted', 'auto_applied')
             AND r2.outcome_at IS NULL
             AND r2.acted_at IS NOT NULL
             AND r2.acted_at > ${at}::timestamptz - make_interval(days => ${RADAR_OUTCOME_WINDOW_DAYS * 2})
             AND i.interaction_date >= r2.acted_at
             AND i.interaction_date <= LEAST(r2.acted_at + make_interval(days => ${RADAR_OUTCOME_WINDOW_DAYS}), ${at}::timestamptz)
             AND (i.source IS NULL OR i.source <> ${AI_DERIVED_SOURCE})
           GROUP BY r2.id
        ) t
       WHERE r.id = t.id
      RETURNING r.id
    `)
  );
  return rows.length;
}

/** The latest completed run, for the page's "Updated 6h ago" stamp. */
export async function loadLastRun(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ finishedAt: radarRuns.finishedAt, status: radarRuns.status, stats: radarRuns.stats })
    .from(radarRuns)
    .where(and(eq(radarRuns.userId, userId), inArray(radarRuns.status, ["ok", "partial"])))
    .orderBy(desc(radarRuns.startedAt))
    .limit(1);
  return row ?? null;
}
