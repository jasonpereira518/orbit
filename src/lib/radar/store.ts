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
import { RADAR_WINDOWS, type RadarPick, type RadarSuppression } from "@/lib/radar/score";
import type {
  RadarAiNote,
  RadarEvidence,
  RadarFeedbackAction,
  RadarReason,
  RecommendationBucket,
  RecommendationKind,
  RecommendationStatus,
} from "@/lib/radar/types";

const DAY_MS = 86_400_000;

/** Terminal rows are kept this long as suppression history, then pruned by the run. */
export const RADAR_HISTORY_DAYS = 90;

const LIVE_STATUSES: RecommendationStatus[] = ["pending", "snoozed"];
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

export function recommendationKey(contactId: string, kind: RecommendationKind) {
  return `${contactId}:${kind}`;
}

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
  const liveAfterWake = new Set(
    live
      .filter((r) => r.status === "pending" || (r.status === "snoozed" && r.snoozedUntil !== null && r.snoozedUntil <= now))
      .map((r) => recommendationKey(r.contactId, r.kind))
  );
  let inserted = 0;
  let updated = 0;
  for (const key of nextKeys) {
    if (liveAfterWake.has(key)) updated++;
    else inserted++;
  }
  let expired = 0;
  for (const key of liveAfterWake) if (!nextKeys.has(key)) expired++;
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
      tx
        .update(recommendations)
        .set({ status: "expired", resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(recommendations.userId, userId),
            eq(recommendations.status, "pending"),
            keys.length
              ? sql`NOT ((${recommendations.contactId}::text || ':' || ${recommendations.kind}) = ANY(ARRAY[${sql.join(
                  keys.map((k) => sql`${k}`),
                  sql`, `
                )}]::text[]))`
              : undefined
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
            targetWhere: sql`${recommendations.status} in ('pending', 'snoozed')`,
            set: {
              score: sql`excluded.score`,
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
      SELECT r.id, r.contact_id, r.kind, r.score, r.bucket, r.reasons, r.evidence, r.ai_note, r.updated_at,
             contacts.full_name, contacts.preferred_name, contacts.title, contacts.company,
             contacts.closeness_tier, contacts.last_interaction_at,
             ${clientAvatarUrlSql} AS avatar_url
        FROM recommendations r
        -- Not aliased: clientAvatarUrlSql names the contacts table in full.
        JOIN contacts ON contacts.id = r.contact_id AND contacts.user_id = r.user_id
       WHERE r.user_id = ${userId} AND r.status = 'pending'
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
    contactName: (r.preferred_name ?? "").trim() || r.full_name,
    title: r.title,
    company: r.company,
    tier: r.closeness_tier,
    avatarUrl: r.avatar_url,
    lastInteractionAt: r.last_interaction_at ? new Date(r.last_interaction_at) : null,
    updatedAt: new Date(r.updated_at),
  }));
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
