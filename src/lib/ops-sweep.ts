import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cronRuns, errorEvents, imports, opsAlertState } from "@/db/schema";
import { aiErrorBreakdown } from "@/lib/admin-health";
import {
  OUR_ERROR_KINDS,
  getOutreachQueueHealth,
  getSystemIssues,
  recentWebhookOutcomes,
} from "@/lib/admin-system";
import { deriveCronRunState, finishCronRun, startCronRun, type CronRunStatus } from "@/lib/cron-runs";
import { getEnvReport } from "@/lib/env";
import { ERROR_SOURCES } from "@/lib/error-events";
import {
  evaluateOpsConditions,
  planTransitions,
  type OpsAlertRow,
  type OpsCondition,
  type OpsSnapshot,
} from "@/lib/ops-alerts";
import { deliverToSlack, type OpsDelivery } from "@/lib/ops-notify";

export type { OpsDelivery } from "@/lib/ops-notify";

/**
 * The ten-minute known-condition sweep: load, evaluate, diff against what was already
 * said, deliver the difference, remember. Triggered by `POST /api/ops/sweep` from the
 * GitHub Actions scheduler (Hobby crons are daily) and by the admin "Run sweep now"
 * button. Records itself in `cron_runs` as `ops.sweep`.
 *
 * If the database itself is unreachable this throws before recording anything, and the
 * route answers 503 without notifying: "the database is down" is owned by the external
 * uptime monitor, and a ten-minute cadence would otherwise repeat it six times an hour.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type DeployFacts = { mainSha: string; mainCommittedAt: Date } | null;

export async function loadOpsSnapshot(now: Date, deploy: DeployFacts): Promise<OpsSnapshot> {
  const db = await getDb();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const [
    lastNightly,
    lastSyncRun,
    webhooks,
    issues,
    outreach,
    aiGroups,
    errorsLastHour,
    failedImports,
  ] = await Promise.all([
      db
        .select()
        .from(cronRuns)
        .where(eq(cronRuns.job, "imports.process-stalled"))
        .orderBy(desc(cronRuns.startedAt))
        .limit(1),
      db
        .select()
        .from(cronRuns)
        .where(eq(cronRuns.job, "sync.run"))
        .orderBy(desc(cronRuns.startedAt))
        .limit(1),
      recentWebhookOutcomes(5, now),
      getSystemIssues(now),
      getOutreachQueueHealth(now),
      aiErrorBreakdown(1, now),
      db
        .select({ source: errorEvents.source, n: sql<number>`count(*)::int` })
        .from(errorEvents)
        .where(gt(errorEvents.createdAt, hourAgo))
        .groupBy(errorEvents.source),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(imports)
        .where(and(eq(imports.status, "failed"), gt(imports.updatedAt, dayAgo))),
    ]);

  const bySource = new Map(errorsLastHour.map((r) => [r.source, r.n]));
  const perfSlow = bySource.get(ERROR_SOURCES.perfSlow) ?? 0;
  const stripeCheckout = bySource.get(ERROR_SOURCES.stripeCheckout) ?? 0;
  const otherErrors = [...bySource.entries()]
    .filter(([source]) => source !== ERROR_SOURCES.perfSlow)
    .reduce((sum, [, n]) => sum + n, 0);

  const outages = new Map<string, { provider: string | null; errorKind: string; accounts: number }>();
  for (const g of aiGroups) {
    if (!OUR_ERROR_KINDS.has(g.errorKind)) continue;
    const key = g.provider ?? "unknown";
    const prev = outages.get(key);
    if (!prev || g.accounts > prev.accounts) {
      outages.set(key, { provider: g.provider, errorKind: g.errorKind, accounts: g.accounts });
    }
  }

  const nightly = lastNightly[0];
  const syncRun = lastSyncRun[0];
  return {
    cron: {
      processStalled: {
        lastStartedAt: nightly?.startedAt ?? null,
        lastState: nightly ? deriveCronRunState(nightly, now) : null,
      },
      syncRun: {
        lastStartedAt: syncRun?.startedAt ?? null,
        lastState: syncRun ? deriveCronRunState(syncRun, now) : null,
      },
    },
    webhooks,
    stripeCheckoutErrorsLastHour: stripeCheckout,
    wedgedImports: issues.wedged,
    failedImportsLast24h: failedImports[0]?.n ?? 0,
    outreach: { overdue: outreach.overdue, oldestOverdueDays: outreach.oldestOverdueDays },
    aiOutages: [...outages.values()],
    errorEventsLastHour: otherErrors,
    perfSlowLastHour: perfSlow,
    missingRequiredEnv: getEnvReport().missingRequired,
    deploy: deploy
      ? { prodSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null, ...deploy }
      : null,
    reauthNeeded: issues.needsReauth,
    wedgedSyncs: issues.syncWedged,
    failingSyncs: issues.syncFailing,
  };
}

export type OpsSweepDeps = {
  deliver: (d: OpsDelivery) => Promise<void>;
  now: () => Date;
  /** Tells the uptime monitor the sweep is alive. Only ever called after a completed sweep. */
  heartbeat: () => Promise<void>;
};

/**
 * Better Stack heartbeat: a GET the monitor expects every ten minutes. When it stops
 * arriving — a dead GitHub schedule, a broken deploy — the monitor pages. Best-effort;
 * a slow heartbeat endpoint must not fail the sweep that just succeeded.
 */
async function pingHeartbeat(): Promise<void> {
  const url = process.env.BETTERSTACK_HEARTBEAT_URL?.trim();
  if (!url) return;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
  } catch {
    // The monitor will notice the gap if this keeps failing; nothing to do here.
  }
}

export type OpsSweepResult = {
  status: CronRunStatus;
  evaluated: number;
  opened: string[];
  reminded: string[];
  recovered: string[];
  active: string[];
  deliveryFailures: number;
};

async function loadPreviousRows(): Promise<OpsAlertRow[]> {
  const db = await getDb();
  const rows = await db.select().from(opsAlertState);
  return rows.map((r) => ({
    id: r.id,
    severity: r.severity,
    active: r.active,
    openedAt: r.openedAt,
    lastSeenAt: r.lastSeenAt,
    lastNotifiedAt: r.lastNotifiedAt,
    notifyCount: r.notifyCount,
    detail: r.detail,
  }));
}

/** A recovered row, re-shaped so the delivery can name what recovered. */
function conditionFromRow(row: OpsAlertRow): OpsCondition {
  const d = row.detail as { title?: unknown; detail?: unknown; href?: unknown };
  return {
    id: row.id,
    severity: row.severity,
    title: typeof d.title === "string" ? d.title : row.id,
    detail: typeof d.detail === "string" ? d.detail : "",
    href: typeof d.href === "string" ? d.href : undefined,
  };
}

export async function runOpsSweep(options: {
  trigger: "schedule" | "manual";
  deploy?: DeployFacts;
  deps?: Partial<OpsSweepDeps>;
  /** Test hook: reshape the loaded snapshot before evaluation. */
  snapshotOverride?: (snapshot: OpsSnapshot) => OpsSnapshot;
}): Promise<OpsSweepResult> {
  const deliver = options.deps?.deliver ?? deliverToSlack;
  const heartbeat = options.deps?.heartbeat ?? pingHeartbeat;
  const now = (options.deps?.now ?? (() => new Date()))();

  // Fails loudly (throws) if the database is down — see the module note.
  const db = await getDb();
  const run = await startCronRun("ops.sweep", options.trigger);

  const result: OpsSweepResult = {
    status: "ok",
    evaluated: 0,
    opened: [],
    reminded: [],
    recovered: [],
    active: [],
    deliveryFailures: 0,
  };

  try {
    let snapshot = await loadOpsSnapshot(now, options.deploy ?? null);
    if (options.snapshotOverride) snapshot = options.snapshotOverride(snapshot);
    const conditions = evaluateOpsConditions(snapshot, now);
    result.evaluated = conditions.length;
    result.active = conditions.map((c) => c.id);

    const previous = await loadPreviousRows();
    const plan = planTransitions(previous, conditions, now);

    const detailOf = (c: OpsCondition) => ({ title: c.title, detail: c.detail, href: c.href ?? null });

    for (const c of plan.open) {
      try {
        await deliver({ kind: "open", condition: c });
      } catch {
        // Left un-persisted on purpose: it opens again next sweep.
        result.deliveryFailures += 1;
        continue;
      }
      await db
        .insert(opsAlertState)
        .values({
          id: c.id,
          severity: c.severity,
          active: true,
          openedAt: now,
          lastSeenAt: now,
          lastNotifiedAt: now,
          notifyCount: 1,
          detail: detailOf(c),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: opsAlertState.id,
          set: {
            severity: c.severity,
            active: true,
            openedAt: now,
            lastSeenAt: now,
            lastNotifiedAt: now,
            notifyCount: sql`${opsAlertState.notifyCount} + 1`,
            detail: detailOf(c),
            updatedAt: now,
          },
        });
      result.opened.push(c.id);
    }

    for (const c of plan.remind) {
      try {
        await deliver({ kind: "remind", condition: c });
      } catch {
        result.deliveryFailures += 1;
        continue;
      }
      await db
        .update(opsAlertState)
        .set({
          lastSeenAt: now,
          lastNotifiedAt: now,
          notifyCount: sql`${opsAlertState.notifyCount} + 1`,
          detail: detailOf(c),
          updatedAt: now,
        })
        .where(eq(opsAlertState.id, c.id));
      result.reminded.push(c.id);
    }

    if (plan.unchanged.length > 0) {
      await db
        .update(opsAlertState)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(inArray(opsAlertState.id, plan.unchanged.map((c) => c.id)));
    }

    for (const row of plan.recover) {
      try {
        await deliver({ kind: "recover", condition: conditionFromRow(row) });
      } catch {
        result.deliveryFailures += 1;
        continue;
      }
      await db
        .update(opsAlertState)
        .set({ active: false, updatedAt: now })
        .where(eq(opsAlertState.id, row.id));
      result.recovered.push(row.id);
    }

    if (result.deliveryFailures > 0) result.status = "partial";
    await finishCronRun(run, {
      status: result.status,
      stats: {
        evaluated: result.evaluated,
        active: result.active.length,
        opened: result.opened.length,
        reminded: result.reminded.length,
        recovered: result.recovered.length,
        deliveryFailures: result.deliveryFailures,
      },
    });
    await heartbeat();
    return result;
  } catch (err) {
    await finishCronRun(run, { status: "failed", error: err });
    throw err;
  }
}
