/**
 * One Radar run for one account: read the network, score it, replace the live list.
 *
 * Callers claim the account's lease first (`claimRadarLease`); the run releases it when it
 * finishes, whether it succeeded or not. Three callers, one code path:
 *
 *   - the nightly pass (`runRadarPass`, driven by `/api/radar/run`),
 *   - the page's first visit (`ensureRadarRun`, inline, bounded, no AI),
 *   - a stale page view (`maybeRefreshRadar`, in `after()`, no AI),
 *   - and the "Refresh now" button, through `src/actions/radar.ts`.
 *
 * `runRadarForUser` never throws. A failure is reported, recorded on the `radar_runs` row,
 * and retried sooner than a success would be.
 */
import { resolveTimeZone } from "@/lib/reminder-due-bucket";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicWrite } from "@/db";
import { radarRuns, userSettings } from "@/db/schema";
import { goalRelevanceComponent } from "@/lib/closeness";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import { loadTargetKeys } from "@/lib/events/companies";
import { traced } from "@/lib/perf-trace";
import {
  NO_SUPPRESSION,
  RADAR_CAPS,
  pickWinner,
  rankPicks,
  scoreContactKinds,
  type RadarContact,
  type RadarPick,
  type RadarSuppression,
} from "@/lib/radar/score";
import { loadCandidates, produceInternalSignals, type RadarCandidateRow } from "@/lib/radar/signals/internal";
import {
  detectRadarOutcomes,
  loadModelTallies,
  loadLiveRecommendations,
  loadSuppressions,
  planDayResult,
  planRunResult,
  writeRunResult,
  type NewRecommendation,
  type WriteCounts,
} from "@/lib/radar/store";
import type { RadarModel, RadarRunTrigger, RadarSignal } from "@/lib/radar/types";
import { buildRadarModel } from "@/lib/radar/model";
import { RADAR_EDITOR_TIMEOUT_MS, editPicks, editorUnchanged } from "@/lib/radar/editor";
import { applyAutopilot, loadRadarAutopilot } from "@/lib/radar/autopilot";
import { draftTodayForRun } from "@/lib/radar/drafts";
import { loadPostSignals } from "@/lib/radar/signals/activity";
import { produceEmailSignals } from "@/lib/radar/signals/email";
import { openRadarAi } from "@/lib/radar/explain";
import { radarNoteKey } from "@/lib/radar/why-prompt";
import { reportError, reportUnlessQuiet } from "@/lib/report-error";
import { runSettledPool } from "@/lib/sync-scheduler";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { focusFromCareerProfile } from "@/lib/career-profile-server";
import { resolvePlan } from "@/lib/entitlements";
import { getRadarLimitsForPlan } from "@/lib/plans/plan-config";
import { focusFitComponent, type UserFocus } from "@/lib/focus-fit";
import { listActiveProjectsForUser, scoreProjectMatch, type UserProject } from "@/lib/projects/store";
import { extractActiveProjectsForUser } from "@/lib/projects/extract";
import { prepareSuggestedCalendarInvite } from "@/lib/radar/invites";
import { LANE_OF_KIND, leadReason } from "@/lib/radar/types";
import { connectSignals, judgeConnectPairs, loadConnectPairs } from "@/lib/radar/connect";
import { metContactIds } from "@/lib/met-contact";
import { buildProofIndex, verifyPicks } from "@/lib/radar/verify";
import { composeDay, composeWeek, nextLocal5am, nextRadarRunAt, radarRunMode, type RadarRunMode } from "@/lib/radar/week";

const HOUR_MS = 3_600_000;

/** How long a claimed account stays claimed if its run dies without releasing it. */
export const RADAR_LEASE_MS = 10 * 60 * 1000;
/** The UTC hour the nightly pass aims every account at. `ops.yml` runs it at 04:17. */
export const RADAR_NIGHTLY_HOUR_UTC = 4;
/** A failed run retries after this, rather than waiting for the next night. */
const RETRY_AFTER_MS = 6 * HOUR_MS;
/** A page view older than this since the last run refreshes in the background. */
export const RADAR_STALE_MS = 24 * HOUR_MS;
/**
 * The most a weekly build spends on AI, shared in order: the editor (at most
 * `RADAR_EDITOR_TIMEOUT_MS`), which orders the plan and writes each card's why and opener in
 * one call, then the plan-gated drafts with whatever is left. A daily pass spends none.
 */
export const RADAR_AI_BUDGET_MS = 25_000;
/**
 * The editor's off switch. If `/admin/analytics/radar` shows cards it moved up are not
 * accepted more often than cards it moved down, it is noise: turn it off here, and the plan
 * keeps the scorer's order and reasons (a card's why can still be asked for on demand).
 */
export const RADAR_EDITOR_ENABLED = true;

export type RadarRunOptions = {
  trigger: RadarRunTrigger;
  now?: Date;
  /** Write the one-line AI "why" for Today's cards. Off for page-triggered runs. */
  ai?: boolean;
  /** Wall-clock budget for the parts that can be skipped (the AI lines). */
  budgetMs?: number;
  /** Force weekly or daily. Unset: weekly when no weekly build ran this local week (`week.ts`). */
  mode?: RadarRunMode;
};

export type RadarRunStats = {
  ok: boolean;
  candidates: number;
  signals: number;
  recommendations: number;
  inserted: number;
  updated: number;
  expired: number;
  aiNotes: number;
  skippedNoKey: boolean;
  /** Accepted cards that led to a real conversation since the last run. */
  outcomes: number;
  /** Cards the AI rerank moved, and whether it failed or reused a cached answer. */
  reranked: number;
  rerankFailed: boolean;
  rerankCached: boolean;
  /** Drafts written for Today's cards, and follow-ups autopilot scheduled. */
  drafts: number;
  autopilot: number;
  /** Saved LinkedIn posts the run read for its candidates. */
  posts: number;
  /** Signals read from the user's mail this run (accounts that opted in to email insights). */
  emailSignals: number;
  /** Cards dropped because their lead reason had no proof that held (`verify.ts`). */
  unproven: number;
  /** Weekly: the plan was built. Daily: the plan kept, only Today and retirements changed. */
  mode?: RadarRunMode;
  durationMs: number;
};

/** Moved to `week.ts` with the rest of Radar's rhythm; re-exported for older callers. */
export { nextLocal5am };

/** The next daily 5:00 AM local run slot at least `MIN_GAP_MS` away. */
export function nextNightlyRunAt(now: Date, tz: string = "UTC"): Date {
  return nextLocal5am(now, tz);
}

/**
 * Claim one account for a run. One statement: it succeeds only when no other run holds a
 * live lease, so a page view and the nightly pass cannot run one account twice.
 */
export async function claimRadarLease(userId: string, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(userSettings)
    .set({ radarLeaseUntil: new Date(now.getTime() + RADAR_LEASE_MS) })
    .where(
      and(
        eq(userSettings.userId, userId),
        or(isNull(userSettings.radarLeaseUntil), lt(userSettings.radarLeaseUntil, now))
      )
    )
    .returning();
  return rows.length > 0;
}

export type RadarState = {
  lastRunAt: Date | null;
  nextAt: Date | null;
  /**
   * True when Radar must not run: the person paused it, or never turned it on. Radar is off
   * by default (schema v225), so every on-demand build reads "never turned on" as paused.
   */
  paused: boolean;
  /** When the person first pressed "Turn on Radar"; null = never. */
  enabledAt: Date | null;
};

/** Radar runs only for an account that turned it on and has not paused it since. */
export function radarIsOn(enabledAt: Date | string | null | undefined, paused: number | null | undefined): boolean {
  return enabledAt != null && paused !== 1;
}

export async function loadRadarState(userId: string): Promise<RadarState | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      lastRunAt: userSettings.radarLastRunAt,
      nextAt: userSettings.radarNextAt,
      paused: userSettings.radarPaused,
      enabledAt: userSettings.radarEnabledAt,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row
    ? { lastRunAt: row.lastRunAt, nextAt: row.nextAt, paused: !radarIsOn(row.enabledAt, row.paused), enabledAt: row.enabledAt }
    : null;
}

function toRadarContact(
  row: RadarCandidateRow,
  targetKeys: Map<string, number>,
  goals: string[],
  focus: UserFocus | null = null,
  projects: readonly UserProject[] = []
): RadarContact {
  let targetPriority: 1 | 2 | 3 | null = null;
  for (const key of companyMatchKeys(row.company)) {
    const p = targetKeys.get(key);
    if (p !== undefined && (targetPriority === null || p < targetPriority)) targetPriority = Math.min(3, Math.max(1, p)) as 1 | 2 | 3;
  }
  const projectMatch = scoreProjectMatch(projects, `${row.fullName} ${row.title ?? ""} ${row.company ?? ""}`);
  return {
    id: row.id,
    company: row.company,
    tier: row.tier,
    priorityLevel: row.priorityLevel,
    relationshipScore: row.relationshipScore,
    statedCloseness: row.statedCloseness,
    firstInteractionAt: row.firstInteractionAt,
    lastInteractionAt: row.lastInteractionAt,
    nextFollowUpAt: row.nextFollowUpAt,
    constellationPin: row.constellationPin,
    cadenceDays: row.cadenceDays,
    cadencePhrase: row.cadencePhrase,
    targetPriority,
    goalFit: goals.length ? goalRelevanceComponent({ company: row.company, title: row.title, industry: row.industry }, goals) : 0,
    focusFit: focus ? focusFitComponent({ title: row.title, industry: row.industry }, focus) : 0,
    projectFit: projectMatch.bestProject ? { score: projectMatch.score, projectTitle: projectMatch.bestProject.title } : undefined,
    hasEvidence: row.hasEvidence,
  };
}

/** Score every candidate and keep the run's final list. Pure given its inputs. */
export function scoreCandidates(
  candidates: readonly RadarCandidateRow[],
  signals: readonly RadarSignal[],
  targetKeys: Map<string, number>,
  goals: string[],
  suppressions: Map<string, RadarSuppression>,
  now: Date,
  model: RadarModel | null = null,
  focus: UserFocus | null = null,
  timeZone = "UTC",
  projects: readonly UserProject[] = []
): NewRecommendation[] {
  return rankPicks(scorePicks(candidates, signals, targetKeys, goals, suppressions, now, model, focus, timeZone, projects), RADAR_CAPS);
}

/** Every person's winning card, before the caps: what the rerank chooses its shortlist from. */
export function scorePicks(
  candidates: readonly RadarCandidateRow[],
  signals: readonly RadarSignal[],
  targetKeys: Map<string, number>,
  goals: string[],
  suppressions: Map<string, RadarSuppression>,
  now: Date,
  model: RadarModel | null = null,
  focus: UserFocus | null = null,
  timeZone = "UTC",
  projects: readonly UserProject[] = []
): NewRecommendation[] {
  const byContact = new Map<string, RadarSignal[]>();
  for (const s of signals) {
    const list = byContact.get(s.contactId);
    if (list) list.push(s);
    else byContact.set(s.contactId, [s]);
  }
  const picks: RadarPick[] = [];
  const rowById = new Map<string, RadarCandidateRow>();
  for (const row of candidates) {
    rowById.set(row.id, row);
    const contact = toRadarContact(row, targetKeys, goals, focus, projects);
    const kinds = scoreContactKinds(contact, byContact.get(row.id) ?? [], suppressions.get(row.id) ?? NO_SUPPRESSION, now, model, timeZone);
    const pick = pickWinner(row.id, kinds, now);
    if (pick) {
      if (row.email && (pick.bucket === "today" || pick.score >= 45)) {
        const lead = leadReason(pick.reasons);
        pick.suggestedCalendarInvite = prepareSuggestedCalendarInvite(
          { fullName: (row.preferredName ?? "").trim() || row.fullName, email: row.email },
          lead?.label ?? pick.kind,
          now,
          timeZone
        );
      }
      picks.push(pick);
    }
  }
  return picks.map((pick) => {
    const row = rowById.get(pick.contactId)!;
    const inputsHash = radarNoteKey({
      contactName: (row.preferredName ?? "").trim() || row.fullName,
      title: row.title,
      company: row.company,
      kind: pick.kind,
      reasons: pick.reasons,
      evidence: pick.evidence,
    });
    return { ...pick, inputsHash };
  });
}

/**
 * Run Radar for one account whose lease the caller holds. Never throws.
 */
export async function runRadarForUser(userId: string, opts: RadarRunOptions): Promise<RadarRunStats> {
  const now = opts.now ?? new Date();
  const startedMs = Date.now();
  const stats: RadarRunStats = {
    ok: false,
    candidates: 0,
    signals: 0,
    recommendations: 0,
    inserted: 0,
    updated: 0,
    expired: 0,
    aiNotes: 0,
    skippedNoKey: false,
    outcomes: 0,
    reranked: 0,
    rerankFailed: false,
    rerankCached: false,
    drafts: 0,
    autopilot: 0,
    posts: 0,
    emailSignals: 0,
    unproven: 0,
    durationMs: 0,
  };
  const db = await getDb();
  let runId: string | null = null;
  let error: unknown = null;
  let learned: RadarModel | null = null;
  let userTz = "UTC";
  let dailyEnabled = true;

  try {
    await traced(
      "radar.run",
      async () => {
        const [run] = await db.insert(radarRuns).values({ userId, trigger: opts.trigger, startedAt: now }).returning();
        runId = run!.id;

        const [signals, emailSignals, goals, targetKeys, live, outcomes, tallies, settingsRow, initialProjects] = await Promise.all([
          produceInternalSignals(userId, now),
          // Events read from the user's mail, for accounts that opted in. A failure costs the
          // run these signals, never its list.
          produceEmailSignals(userId, now).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.email", userId, level: "warning" });
            return [] as RadarSignal[];
          }),
          listActiveGoalTextsForUser(userId, { limit: 8 }),
          loadTargetKeys(userId),
          loadLiveRecommendations(userId),
          // Measurement, not ranking: which accepts turned into conversations. It never
          // blocks the list, so a failure here costs the stat, not the run.
          detectRadarOutcomes(userId, now).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.outcomes", userId, level: "warning" });
            return 0;
          }),
          // What this account has taught Radar. A failure scores neutrally, never fails the run.
          loadModelTallies(userId, now).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.model", userId, level: "warning" });
            return null;
          }),
          db
            .select({
              tz: userSettings.radarDigestTz,
              lastRunAt: userSettings.radarLastRunAt,
              dailyEnabled: userSettings.radarDailyEnabled,
              // The last weekly build, on the same statement: the run's mode depends on it.
              lastWeeklyAt: sql<string | Date | null>`(SELECT max(started_at) FROM radar_runs WHERE user_id = ${userId} AND status = 'ok' AND stats ->> 'mode' = 'weekly')`,
              autoProjects: userSettings.radarAutoProjects,
              careerProfile: userSettings.careerProfile,
              compedPlan: userSettings.compedPlan,
              lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
              subscriptionPlan: userSettings.subscriptionPlan,
              subscriptionStatus: userSettings.subscriptionStatus,
              subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1)
            .then(([r]) => r ?? null)
            .catch(() => null),
          listActiveProjectsForUser(userId).catch(() => [] as UserProject[]),
        ]);
        stats.outcomes = outcomes;
        userTz = resolveTimeZone(settingsRow?.tz);
        dailyEnabled = settingsRow?.dailyEnabled !== 0;
        const lastWeeklyAt = settingsRow?.lastWeeklyAt ? new Date(settingsRow.lastWeeklyAt) : null;
        const mode: RadarRunMode = opts.mode ?? radarRunMode(lastWeeklyAt, now, userTz);
        stats.mode = mode;
        const focus = focusFromCareerProfile(settingsRow?.careerProfile);
        const model = tallies ? buildRadarModel(tallies, now) : null;
        learned = model;

        const aiDeadline = deadlineAfter(Math.min(opts.budgetMs ?? RADAR_AI_BUDGET_MS, RADAR_AI_BUDGET_MS));
        const access = opts.ai ? await openRadarAi(userId) : null;
        if (opts.ai && !access) stats.skippedNoKey = true;

        // Plan tiering and capabilities (derived from settingsRow without extra queries)
        const { plan: userPlan } = resolvePlan(settingsRow, now);
        const radarLimits = getRadarLimitsForPlan(userPlan);

        // Active projects: refreshed on the weekly build only. The model reads recent notes and
        // mail only on plans with AI explanations; otherwise projects are seeded from goals, no AI.
        let activeProjects: UserProject[] = initialProjects;
        const projectAi = radarLimits.aiExplanations ? access : null;
        if (
          settingsRow?.autoProjects !== 0 &&
          mode === "weekly" &&
          (projectAi || (activeProjects.length === 0 && goals.length > 0))
        ) {
          activeProjects = await extractActiveProjectsForUser(userId, projectAi ?? undefined, {
            since: settingsRow?.lastRunAt ?? undefined,
            goals,
            existingProjects: activeProjects,
          }).catch(() => activeProjects);
        }

        // No outbound people discovery here: Radar never writes to `contacts`. New people are
        // shown as opportunities the user chooses to save (docs/superpowers/specs/2026-11-10-radar-analyst-design.md).
        // Connect (weekly, plan-gated): links between the person's notes and the people they
        // know, judged in one call. Only people they have met can be paired.
        let connect: RadarSignal[] = [];
        if (mode === "weekly" && access && radarLimits.connectPerWeek > 0 && !deadlineReached(aiDeadline)) {
          connect = await metContactIds(userId)
            .then((met) => loadConnectPairs(userId, met, now))
            .then(async (pairs) => connectSignals(pairs, await judgeConnectPairs(userId, access, pairs, goals, { timeoutMs: Math.max(1_000, Math.min(10_000, aiDeadline - Date.now())) })))
            .catch((err) => {
              reportUnlessQuiet(err, { where: "job.radar.connect", userId, level: "warning" });
              return [];
            });
        }

        const [candidates, suppressions] = await Promise.all([
          loadCandidates(userId, [...emailSignals, ...signals, ...connect].map((s) => s.contactId)),
          loadSuppressions(userId, live, now),
        ]);

        // Posts the person saved from LinkedIn with the extension, and what the people check
        // found on the web (src/lib/radar/pulse.ts). The news sweep and the
        // Bluesky/Mastodon polling are gone (docs/superpowers/specs/2026-11-10-radar-analyst-design.md).
        const posts = await loadPostSignals(userId, new Set(candidates.map((c) => c.id)), now).catch((err) => {
          reportUnlessQuiet(err, { where: "job.radar.posts", userId, level: "warning" });
          return [];
        });
        stats.posts = posts.length;
        // Email signals first: a card keeps at most two pieces of evidence, and the one from
        // mail is the one an accept needs to find its email again.
        const allSignals = [...emailSignals, ...signals, ...posts, ...connect];
        const scored = scorePicks(
          candidates,
          allSignals,
          targetKeys,
          goals,
          suppressions,
          now,
          model,
          focus,
          userTz,
          activeProjects
        );

        // No proof, no card: the index is only what this run read (its signals' source rows and
        // its candidates), each tied to the person it was read for, so a card can only cite
        // something real about its own person, never a namesake's row. Before the rerank, so no AI
        // is spent on a card that would be dropped.
        const proofIndex = buildProofIndex([
          ...allSignals.flatMap((s) => (s.source ? [{ ...s.source, contactId: s.contactId }] : [])),
          // The other side of a Connect link is read for the other person.
          ...allSignals.flatMap((s) => (s.kind === "connect" ? [{ ...s.other.source, contactId: s.other.contactId }] : [])),
          ...candidates.map((c) => ({ table: "contacts" as const, id: c.id, contactId: c.id })),
        ]);
        const verified = verifyPicks(scored, proofIndex);
        const picks = verified.kept;
        stats.unproven = verified.dropped;

        let ranked: NewRecommendation[] = picks;
        // The editor: once a week, it orders the verified picks and writes each card's why and
        // opener in one call. A daily pass leaves the plan's words as they are.
        if (mode === "weekly" && access && RADAR_EDITOR_ENABLED && radarLimits.aiExplanations) {
          const profiles = new Map(candidates.map((c) => [c.id, { title: c.title, company: c.company, tier: c.tier }]));
          const result = await editPicks(userId, access, picks, { goals, profiles }, now, {
            timeoutMs: Math.min(RADAR_EDITOR_TIMEOUT_MS, Math.max(1_000, aiDeadline - Date.now())),
          }).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.editor", userId, level: "warning" });
            return editorUnchanged(picks, "failed");
          });
          ranked = result.picks;
          stats.reranked = result.adjusted;
          stats.rerankFailed = result.status === "failed";
          stats.rerankCached = result.status === "cached";
          stats.aiNotes = result.noted;
        }

        // Connect cards per week, by plan: the best few, never more.
        const connectKeep = new Set(
          ranked
            .filter((p) => LANE_OF_KIND[p.kind] === "connect")
            .sort((a, b) => b.score - a.score)
            .slice(0, radarLimits.connectPerWeek)
            .map((p) => `${p.contactId}:${p.kind}`)
        );
        ranked = ranked.filter((p) => LANE_OF_KIND[p.kind] !== "connect" || connectKeep.has(`${p.contactId}:${p.kind}`));

        // Weekly: build the plan (and Today's moments) from scratch. Daily: keep the plan's rows
        // as they are, add new moments to Today, retire cards whose person has no reason left.
        const limits = { planSize: Math.min(RADAR_CAPS.pending, radarLimits.planSize), todayMax: radarLimits.todayMax };
        let next: NewRecommendation[];
        let counts: WriteCounts;
        if (mode === "weekly") {
          next = composeWeek(ranked, limits, now);
          counts = planRunResult(live, next, now);
          await writeRunResult(userId, runId, next, now);
        } else {
          const day = composeDay(ranked, live, limits, now);
          next = day.insert;
          counts = planDayResult(live, day, now);
          await writeRunResult(userId, runId, next, now, { mode: "daily", keepContacts: day.keepContacts, promote: day.promote });
        }

        // Autopilot, for the kinds this person opted into: schedules, never sends. Only on
        // the nightly pass and an explicit refresh, never while someone is opening the page.
        if (opts.trigger === "schedule" || opts.trigger === "manual") {
          const autopilot = await loadRadarAutopilot(userId).catch(() => ({}));
          stats.autopilot = await applyAutopilot(userId, autopilot, now);
        }

        // Drafts written ahead, on the weekly build only and only as many as the plan allows
        // (Free none: a draft is written when the person asks for one).
        if (mode === "weekly" && access && radarLimits.draftsPerWeek > 0 && !deadlineReached(aiDeadline)) {
          stats.drafts = await draftTodayForRun(userId, access, { deadline: aiDeadline, limit: radarLimits.draftsPerWeek }).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.draft", userId, level: "warning" });
            return 0;
          });
        }

        stats.candidates = candidates.length;
        stats.signals = signals.length;
        stats.emailSignals = emailSignals.length;
        stats.recommendations = next.length;
        stats.inserted = counts.inserted;
        stats.updated = counts.updated;
        stats.expired = counts.expired;
        stats.ok = true;
      },
      { userId }
    );
  } catch (err) {
    error = err;
    reportError(err, { where: "job.radar.user", userId, level: "warning" });
  }

  stats.durationMs = Date.now() - startedMs;
  await finishRun(userId, runId, stats, error, now, learned, userTz, dailyEnabled).catch((err) =>
    reportError(err, { where: "job.radar.finish", userId, level: "warning" })
  );
  return stats;
}

async function finishRun(
  userId: string,
  runId: string | null,
  stats: RadarRunStats,
  error: unknown,
  now: Date,
  model: RadarModel | null,
  tz: string = "UTC",
  dailyEnabled = true
) {
  const db = await getDb();
  const { ok, ...counts } = stats;
  await runAtomicWrite(db, (tx) => {
    const statements = [];
    if (runId) {
      statements.push(
        tx
          .update(radarRuns)
          .set({
            status: ok ? "ok" : "failed",
            finishedAt: new Date(),
            durationMs: stats.durationMs,
            stats: counts,
            error: error ? String(error instanceof Error ? error.message : error).slice(0, 500) : null,
          })
          .where(eq(radarRuns.id, runId))
      );
    }
    statements.push(
      tx
        .update(userSettings)
        .set(
          ok
            ? {
                radarLastRunAt: now,
                radarNextAt: nextRadarRunAt(now, tz, dailyEnabled),
                radarLeaseUntil: null,
                // Saved for the admin view and the next reader; the run itself always
                // rebuilds from rows, so a stale copy here can never steer a ranking.
                ...(model ? { radarModel: model } : {}),
              }
            : { radarNextAt: new Date(now.getTime() + RETRY_AFTER_MS), radarLeaseUntil: null }
        )
        .where(eq(userSettings.userId, userId))
    );
    return statements;
  });
}

/**
 * The page's first visit: no run on record yet, so build one now, inline and bounded, so
 * the first thing a person sees is their list rather than an empty page. Status-agnostic on
 * purpose: an account whose first run found nothing still has a run, and is not rebuilt.
 */
export async function ensureRadarRun(userId: string, now: Date = new Date()): Promise<boolean> {
  const state = await loadRadarState(userId);
  if (!state || state.paused || state.lastRunAt) return false;
  if (!(await claimRadarLease(userId, now))) return false;
  const stats = await runRadarForUser(userId, { trigger: "first_visit", now, ai: false, budgetMs: 15_000 });
  return stats.ok;
}

/** A stale page view: rebuild in the background (callers wrap this in `after()`). */
export async function maybeRefreshRadar(userId: string, now: Date = new Date()): Promise<void> {
  const state = await loadRadarState(userId);
  if (!state || state.paused || !state.lastRunAt) return;
  if (now.getTime() - state.lastRunAt.getTime() < RADAR_STALE_MS) return;
  if (!(await claimRadarLease(userId, now))) return;
  await runRadarForUser(userId, { trigger: "page", now, ai: false, budgetMs: 20_000 });
}

/**
 * A person was just added to the network: rebuild now, so the cards they make possible are
 * there when the page redraws instead of tomorrow. Best effort and bounded, like a stale page
 * view: an account that has never run (its first visit builds the list), a paused one, or one
 * already updating does nothing.
 */
export async function refreshRadarForNewContact(userId: string, now: Date = new Date()): Promise<boolean> {
  const state = await loadRadarState(userId);
  if (!state || state.paused || !state.lastRunAt) return false;
  if (!(await claimRadarLease(userId, now))) return false;
  const stats = await runRadarForUser(userId, { trigger: "page", now, ai: false, budgetMs: 8_000 });
  return stats.ok;
}

/** Turn Radar on: stamp the first time (never overwritten) and clear any pause. */
export async function turnOnRadarForUser(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ radarPaused: 0, radarEnabledAt: sql`coalesce(${userSettings.radarEnabledAt}, now())` })
    .where(eq(userSettings.userId, userId));
}

/** Rows of `radar_runs` for one account, newest first. For the page stamp and the smoke. */
export async function countRadarRuns(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM radar_runs WHERE user_id = ${userId}`)
  );
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ the nightly pass ----- */

/** Under the route's 300 s ceiling, with room for the ledger write. */
export const RADAR_PASS_BUDGET_MS = 270_000;
/** Accounts claimed per pass. The route self-continues when a claim comes back full. */
export const RADAR_USERS_PER_PASS = 25;
/** Accounts run at once. Each is a different account's reads and, at most, six AI calls (the rerank and five why-lines). */
export const RADAR_CONCURRENCY = 4;
/** No account starts unless this much of the budget is left. */
export const RADAR_PER_USER_BUDGET_MS = 45_000;
/** Accounts nobody has used in this long are left alone; their first visit rebuilds. */
export const RADAR_ACTIVE_WITHIN_DAYS = 60;

/**
 * Claim accounts that are due, in one statement. Only accounts that turned Radar on
 * (`radar_enabled_at`) and have not paused it are eligible. While Radar is coming-soon, only accounts
 * that have opened it (`radar_last_run_at IS NOT NULL`) are eligible, so nobody's AI key is
 * spent on a page they cannot see. `last_active_at` is null for accounts that predate the
 * column; they are treated as inactive until their next visit, which builds inline.
 */
export async function claimRadarUsers(limit: number, now: Date, opts: { includeUnopened: boolean }): Promise<string[]> {
  const db = await getDb();
  const lease = new Date(now.getTime() + RADAR_LEASE_MS);
  const activeSince = new Date(now.getTime() - RADAR_ACTIVE_WITHIN_DAYS * 24 * HOUR_MS);
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      UPDATE user_settings SET radar_lease_until = ${lease}
       WHERE id IN (
         SELECT id FROM user_settings
          WHERE radar_paused = 0
            AND radar_enabled_at IS NOT NULL
            -- No daily-pass filter: an account with it off still gets its weekly plan, and
            -- its next_at already points at Monday (nextRadarRunAt).
            AND (radar_next_at IS NULL OR radar_next_at <= ${now})
            AND (radar_lease_until IS NULL OR radar_lease_until < ${now})
            AND last_active_at > ${activeSince}
            AND ${opts.includeUnopened ? sql`TRUE` : sql`radar_last_run_at IS NOT NULL`}
          ORDER BY radar_next_at NULLS FIRST, id
          LIMIT ${limit})
      RETURNING user_id
    `)
  );
  return rows.map((r) => r.user_id);
}

/** Give an account back without running it, due at `dueAt` so the continuation takes it. */
export async function releaseRadarLease(userId: string, dueAt: Date): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ radarLeaseUntil: null, radarNextAt: dueAt })
    .where(eq(userSettings.userId, userId));
}

export type RadarPassStats = {
  claimed: number;
  ran: number;
  failed: number;
  recommendations: number;
  aiNotes: number;
  budgetExhausted: boolean;
  claimFull: boolean;
};

/**
 * One nightly pass: claim due accounts, run each under a shared deadline, and report
 * whether more are waiting. A per-account failure is counted and never rethrown, because
 * `runSettledPool` would swallow it silently otherwise.
 */
export async function runRadarPass(opts: { now?: Date; budgetMs?: number; includeUnopened: boolean }): Promise<RadarPassStats> {
  const now = opts.now ?? new Date();
  const deadline = deadlineAfter(opts.budgetMs ?? RADAR_PASS_BUDGET_MS);
  const startCutoff = deadline - RADAR_PER_USER_BUDGET_MS;
  const stats: RadarPassStats = {
    claimed: 0,
    ran: 0,
    failed: 0,
    recommendations: 0,
    aiNotes: 0,
    budgetExhausted: false,
    claimFull: false,
  };
  const claimed = await claimRadarUsers(RADAR_USERS_PER_PASS, now, { includeUnopened: opts.includeUnopened });
  stats.claimed = claimed.length;
  stats.claimFull = claimed.length >= RADAR_USERS_PER_PASS;

  await runSettledPool(claimed, RADAR_CONCURRENCY, async (userId) => {
    if (deadlineReached(startCutoff)) {
      stats.budgetExhausted = true;
      await releaseRadarLease(userId, now).catch(() => undefined);
      return;
    }
    const result = await runRadarForUser(userId, {
      trigger: "schedule",
      now: opts.now,
      ai: true,
      budgetMs: RADAR_PER_USER_BUDGET_MS,
    });
    if (result.ok) stats.ran++;
    else stats.failed++;
    stats.recommendations += result.recommendations;
    stats.aiNotes += result.aiNotes;
  });
  return stats;
}
