import { sql } from "drizzle-orm";
import { and, desc, eq, gt } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, isPgvectorAvailable, rowsOf } from "@/db";
import { errorEvents, opsAlertState } from "@/db/schema";
import { ERROR_SOURCES } from "@/lib/error-events";
import { getEnvReport } from "@/lib/env";
import { getCronHealth, getSystemIssues, recentWebhookOutcomes } from "@/lib/admin-system";

/**
 * The health probe behind `GET /api/health`.
 *
 * Polled by the external uptime monitor and by the GitHub Actions scheduler, so it has
 * three obligations: answer 503 for the two things that make the whole app wrong (the
 * database is unreachable, or the schema is behind the code), never hang past the
 * monitor's own timeout, and never tell an anonymous caller anything about
 * configuration. The DEEP view — behind HEALTH_TOKEN — adds the operational facts the ops
 * sweep also reads; a degraded deep view is still HTTP 200, because "a cron is late" must
 * not page as "the site is down".
 *
 * A function killed at its `maxDuration` never answers at all; the monitor's response-time
 * alert is what covers that class, which is why the probe also reports DB latency.
 */

export type HealthReason = "db_error" | "db_timeout" | "schema_mismatch";

export type HealthReport = {
  status: "ok" | "degraded" | "down";
  httpStatus: 200 | 503;
  checkedAt: string;
  /** `VERCEL_GIT_COMMIT_SHA` — the only code production is running. */
  sha: string | null;
  deploymentId: string | null;
  builtAt: string | null;
  env: string | null;
  schema: { expected: number; recorded: number | null };
  db: { ok: boolean; latencyMs: number | null; reason: HealthReason | null };
  cron?: {
    processStalled: { state: string | null; startedAt: string | null; missed: boolean };
    sweep: { state: string | null; startedAt: string | null };
  };
  webhooks?: Record<string, string[]>;
  issues?: { wedged: number; overdue: number; calendarErrors: number; needsReauth: number };
  config?: {
    missingRequired: string[];
    warnings: number;
    sentry: boolean;
    slack: boolean;
    pgvector: boolean | null;
  };
  alerts?: Array<{ id: string; severity: string; openedAt: string; title: string | null }>;
  /** Slow calls recorded in the last hour (see perf-trace.ts). */
  slowCallsLastHour?: number;
};

const DEFAULT_TIMEOUT_MS = 4_000;

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError("timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The recorded schema version, via one statement on the real database. */
async function probeSchemaVersion(): Promise<{ recorded: number | null }> {
  const db = await getDb();
  const res = await db.execute(sql`SELECT version FROM schema_migrations WHERE id = 1`);
  const row = rowsOf<{ version: number | string }>(res)[0];
  return { recorded: row ? Number(row.version) : null };
}

/** Best-effort: a failing section reads as null rather than failing the probe. */
async function section<T>(work: () => Promise<T>, ms: number): Promise<T | null> {
  try {
    return await withTimeout(work(), ms);
  } catch {
    return null;
  }
}

export async function checkHealth(options: {
  deep: boolean;
  timeoutMs?: number;
  now?: Date;
  probeDb?: () => Promise<{ recorded: number | null }>;
}): Promise<HealthReport> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probe = options.probeDb ?? probeSchemaVersion;

  const started = Date.now();
  let recorded: number | null = null;
  let reason: HealthReason | null = null;
  try {
    ({ recorded } = await withTimeout(probe(), timeoutMs));
    if (recorded !== SCHEMA_VERSION) reason = "schema_mismatch";
  } catch (err) {
    reason = err instanceof TimeoutError ? "db_timeout" : "db_error";
  }
  const latencyMs = reason === "db_error" || reason === "db_timeout" ? null : Date.now() - started;

  const report: HealthReport = {
    status: reason ? "down" : "ok",
    httpStatus: reason ? 503 : 200,
    checkedAt: now.toISOString(),
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    builtAt: process.env.BUILD_TIME ?? null,
    env: process.env.VERCEL_ENV ?? null,
    schema: { expected: SCHEMA_VERSION, recorded },
    db: { ok: !reason || reason === "schema_mismatch", latencyMs, reason },
  };

  if (!options.deep || report.status === "down") return report;

  const [nightly, sweep, webhooks, issues, alerts, slow, pgvector] = await Promise.all([
    section(() => getCronHealth("imports.process-stalled", now), timeoutMs),
    section(() => getCronHealth("ops.sweep", now), timeoutMs),
    section(() => recentWebhookOutcomes(5, now), timeoutMs),
    section(() => getSystemIssues(now), timeoutMs),
    section(async () => {
      const db = await getDb();
      return db
        .select()
        .from(opsAlertState)
        .where(eq(opsAlertState.active, true))
        .orderBy(desc(opsAlertState.openedAt));
    }, timeoutMs),
    section(async () => {
      const db = await getDb();
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(errorEvents)
        .where(
          and(
            eq(errorEvents.source, ERROR_SOURCES.perfSlow),
            gt(errorEvents.createdAt, new Date(now.getTime() - 60 * 60 * 1000))
          )
        );
      return row?.n ?? 0;
    }, timeoutMs),
    section(async () => Boolean(await isPgvectorAvailable()), timeoutMs),
  ]);

  const envReport = getEnvReport();
  report.cron = {
    processStalled: {
      state: nightly?.lastRun?.state ?? null,
      startedAt: nightly?.lastRun?.startedAt.toISOString() ?? null,
      missed: nightly?.missed ?? true,
    },
    sweep: {
      state: sweep?.lastRun?.state ?? null,
      startedAt: sweep?.lastRun?.startedAt.toISOString() ?? null,
    },
  };
  report.webhooks = webhooks ?? {};
  report.issues = issues ?? { wedged: 0, overdue: 0, calendarErrors: 0, needsReauth: 0 };
  report.config = {
    missingRequired: envReport.missingRequired,
    warnings: envReport.warnings.length,
    sentry: Boolean(process.env.SENTRY_DSN),
    slack: Boolean(process.env.SLACK_OPS_WEBHOOK_URL),
    pgvector,
  };
  report.alerts = (alerts ?? []).map((a) => ({
    id: a.id,
    severity: a.severity,
    openedAt: a.openedAt.toISOString(),
    title: typeof a.detail?.title === "string" ? a.detail.title : null,
  }));
  report.slowCallsLastHour = slow ?? 0;

  const degraded =
    report.cron.processStalled.missed ||
    envReport.missingRequired.length > 0 ||
    (report.alerts ?? []).some((a) => a.severity !== "info") ||
    Object.values(report.issues).some((n) => n > 0);
  if (degraded) report.status = "degraded";
  return report;
}
