/**
 * Is Radar working? Aggregates for `/admin/analytics/radar`, across every account.
 *
 * Nothing here is new tracking. Every number is read from rows Radar already keeps for its
 * own reasons: `recommendations` (status, impressions, `acted_at`, `outcome_at`, the rerank's
 * `ai_delta`, the pre-written `draft`) and `radar_runs`. Three statements; the shaping is a
 * pure function so the smoke can check the arithmetic on rows it wrote itself.
 *
 * Definitions, stated once so every tile means the same thing:
 *   shown      a card first seen in the window (an impression, debounced per 6 h)
 *   accepted   scheduled by the person, or applied by autopilot and not undone
 *   dismissed  dismissed, including "not for this person"
 *   ignored    seen three or more times, then expired without any action
 *   converted  accepted, and a real conversation followed within 14 days
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { RECOMMENDATION_KINDS, type RecommendationKind } from "@/lib/radar/types";

export const RADAR_METRIC_WINDOWS = [7, 28] as const;
export type RadarMetricWindow = (typeof RADAR_METRIC_WINDOWS)[number];

/** Cards seen at least this many times and never acted on count as ignored. */
export const RADAR_IGNORED_MIN_SEEN = 3;

export type RadarRerankGroup = "promoted" | "demoted" | "untouched";

/** One row of the grouped card aggregate, as the database returns it. */
export type RadarMetricRow = {
  kind: RecommendationKind;
  rerank: RadarRerankGroup;
  hasDraft: boolean;
  shown: number;
  accepted: number;
  dismissed: number;
  snoozed: number;
  ignored: number;
  converted: number;
};

export type RadarRates = {
  shown: number;
  accepted: number;
  dismissed: number;
  snoozed: number;
  ignored: number;
  converted: number;
  /** accepted / shown, 0–1. Null when nothing was shown. */
  acceptRate: number | null;
  /** converted / accepted, 0–1. Null when nothing was accepted. */
  convertRate: number | null;
  /** ignored / shown, 0–1. Null when nothing was shown. */
  ignoreRate: number | null;
};

export type RadarMetrics = {
  windowDays: RadarMetricWindow;
  totals: RadarRates;
  kinds: Array<{ kind: RecommendationKind } & RadarRates>;
  /** The rerank's report card: do cards it moved up get accepted more than the rest? */
  rerank: Record<RadarRerankGroup, RadarRates>;
  /** Cards that came with a pre-written draft, against cards that did not. */
  drafts: { withDraft: RadarRates; without: RadarRates };
  medianHoursToAction: number | null;
  accountsShown: number;
  runs: { total: number; failed: number; p95Ms: number | null; avgAiNotes: number | null; accounts: number };
};

function emptyTally() {
  return { shown: 0, accepted: 0, dismissed: 0, snoozed: 0, ignored: 0, converted: 0 };
}
type Tally = ReturnType<typeof emptyTally>;

function add(into: Tally, row: Tally) {
  into.shown += row.shown;
  into.accepted += row.accepted;
  into.dismissed += row.dismissed;
  into.snoozed += row.snoozed;
  into.ignored += row.ignored;
  into.converted += row.converted;
}

function rates(t: Tally): RadarRates {
  return {
    ...t,
    acceptRate: t.shown ? t.accepted / t.shown : null,
    convertRate: t.accepted ? t.converted / t.accepted : null,
    ignoreRate: t.shown ? t.ignored / t.shown : null,
  };
}

/** Shape the grouped rows into the page's tiles and tables. Pure. */
export function summarizeRadarMetrics(
  rows: readonly RadarMetricRow[],
  extra: Omit<RadarMetrics, "totals" | "kinds" | "rerank" | "drafts">
): RadarMetrics {
  const totals = emptyTally();
  const byKind = new Map<RecommendationKind, Tally>(RECOMMENDATION_KINDS.map((k) => [k, emptyTally()]));
  const byRerank: Record<RadarRerankGroup, Tally> = {
    promoted: emptyTally(),
    demoted: emptyTally(),
    untouched: emptyTally(),
  };
  const withDraft = emptyTally();
  const without = emptyTally();
  for (const row of rows) {
    add(totals, row);
    const k = byKind.get(row.kind);
    if (k) add(k, row);
    add(byRerank[row.rerank] ?? byRerank.untouched, row);
    add(row.hasDraft ? withDraft : without, row);
  }
  return {
    ...extra,
    totals: rates(totals),
    kinds: RECOMMENDATION_KINDS.map((kind) => ({ kind, ...rates(byKind.get(kind)!) })),
    rerank: {
      promoted: rates(byRerank.promoted),
      demoted: rates(byRerank.demoted),
      untouched: rates(byRerank.untouched),
    },
    drafts: { withDraft: rates(withDraft), without: rates(without) },
  };
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadRadarMetrics(windowDays: RadarMetricWindow, now: Date = new Date()): Promise<RadarMetrics> {
  const db = await getDb();
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const [cardRows, actionRows, runRows] = await Promise.all([
    db.execute(sql`
      SELECT kind,
             CASE WHEN ai_delta > 0 THEN 'promoted' WHEN ai_delta < 0 THEN 'demoted' ELSE 'untouched' END AS rerank,
             (draft IS NOT NULL) AS has_draft,
             count(*)::int AS shown,
             count(*) FILTER (WHERE status IN ('accepted', 'auto_applied'))::int AS accepted,
             count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
             count(*) FILTER (WHERE status = 'snoozed')::int AS snoozed,
             count(*) FILTER (
               WHERE status = 'expired' AND acted_at IS NULL AND seen_count >= ${RADAR_IGNORED_MIN_SEEN}
             )::int AS ignored,
             count(*) FILTER (WHERE outcome_at IS NOT NULL)::int AS converted
        FROM recommendations
       WHERE first_seen_at >= ${since}::timestamptz
       GROUP BY 1, 2, 3
    `),
    db.execute(sql`
      SELECT count(DISTINCT user_id)::int AS accounts,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM acted_at - first_seen_at)
             ) FILTER (WHERE acted_at IS NOT NULL AND acted_at >= first_seen_at) AS median_seconds
        FROM recommendations
       WHERE first_seen_at >= ${since}::timestamptz
    `),
    db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
             avg(coalesce((stats ->> 'aiNotes')::numeric, 0)) AS avg_ai_notes,
             count(DISTINCT user_id)::int AS accounts
        FROM radar_runs
       WHERE started_at >= ${since}::timestamptz
    `),
  ]);

  const rows = rowsOf<{
    kind: RecommendationKind;
    rerank: RadarRerankGroup;
    has_draft: boolean;
    shown: number;
    accepted: number;
    dismissed: number;
    snoozed: number;
    ignored: number;
    converted: number;
  }>(cardRows).map((r) => ({
    kind: r.kind,
    rerank: r.rerank,
    hasDraft: Boolean(r.has_draft),
    shown: num(r.shown),
    accepted: num(r.accepted),
    dismissed: num(r.dismissed),
    snoozed: num(r.snoozed),
    ignored: num(r.ignored),
    converted: num(r.converted),
  }));
  const action = rowsOf<{ accounts: number; median_seconds: number | string | null }>(actionRows)[0];
  const run = rowsOf<{
    total: number;
    failed: number;
    p95_ms: number | string | null;
    avg_ai_notes: number | string | null;
    accounts: number;
  }>(runRows)[0];

  const medianSeconds = numOrNull(action?.median_seconds);
  return summarizeRadarMetrics(rows, {
    windowDays,
    medianHoursToAction: medianSeconds === null ? null : medianSeconds / 3600,
    accountsShown: num(action?.accounts),
    runs: {
      total: num(run?.total),
      failed: num(run?.failed),
      p95Ms: numOrNull(run?.p95_ms),
      avgAiNotes: numOrNull(run?.avg_ai_notes),
      accounts: num(run?.accounts),
    },
  });
}
