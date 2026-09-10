import { after } from "next/server";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { operationalEvents } from "@/db/schema";

export type OperationalSeverity = "info" | "warn" | "error";
export type OperationalSource =
  | "app"
  | "job"
  | "webhook"
  | "integration"
  | "provider"
  | "admin";

export type OperationalMetadata = Record<
  string,
  string | number | boolean | null
>;

export type OperationalEventInput = {
  severity: OperationalSeverity;
  source: OperationalSource;
  eventType: string;
  message: string;
  success?: boolean | null;
  userId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  correlationId?: string | null;
  durationMs?: number | null;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

const FORBIDDEN_METADATA_KEY =
  /(authorization|cookie|secret|token|api.?key|payload|request.?body|response.?body|stack|content|notes?|phone|email|full.?name)/i;
const SAFE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/i;

/**
 * Convert arbitrary caller metadata into the deliberately tiny shape the journal accepts.
 * Forbidden or nested values are dropped rather than stringified, preventing a future
 * caller from accidentally turning a provider payload into a log entry.
 */
export function sanitizeOperationalMetadata(
  input: Record<string, unknown> | undefined
): OperationalMetadata {
  const safe: OperationalMetadata = {};
  if (!input) return safe;

  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_KEY.test(key) || FORBIDDEN_METADATA_KEY.test(key)) continue;
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    } else if (typeof value === "string") {
      safe[key] = value.slice(0, 240);
    }
  }
  return safe;
}

/** Awaitable, failure-isolated write for webhooks, jobs, and admin operations. */
export async function recordOperationalEvent(
  input: OperationalEventInput
): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insert(operationalEvents)
      .values({
        severity: input.severity,
        source: input.source,
        eventType: input.eventType.slice(0, 120),
        message: input.message.slice(0, 300),
        success:
          input.success == null ? null : input.success ? 1 : 0,
        userId: input.userId ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        correlationId: input.correlationId ?? null,
        durationMs:
          input.durationMs == null
            ? null
            : Math.max(0, Math.round(input.durationMs)),
        dedupeKey: input.dedupeKey ?? null,
        metadata: sanitizeOperationalMetadata(input.metadata),
        occurredAt: input.occurredAt ?? new Date(),
      })
      .onConflictDoNothing();
  } catch {
    // Observability must never turn a successful product operation into a failure.
  }
}

/** Fire-and-forget variant that works both inside and outside a request scope. */
export function deferOperationalEvent(input: OperationalEventInput): void {
  const write = () => recordOperationalEvent(input);
  try {
    after(write);
  } catch {
    void write();
  }
}

export type OperationalEventQuery = {
  severity?: OperationalSeverity;
  source?: OperationalSource;
  eventType?: string;
  userId?: string;
  q?: string;
  since?: Date;
  before?: Date;
  limit?: number;
};

export type OperationalEventPage = {
  rows: Array<typeof operationalEvents.$inferSelect>;
  hasMore: boolean;
  nextBefore: string | null;
};

export async function loadOperationalEvents(
  query: OperationalEventQuery = {}
): Promise<OperationalEventPage> {
  const db = await getDb();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 5_000);
  const filters: SQL[] = [];
  if (query.severity) filters.push(eq(operationalEvents.severity, query.severity));
  if (query.source) filters.push(eq(operationalEvents.source, query.source));
  if (query.eventType) filters.push(eq(operationalEvents.eventType, query.eventType));
  if (query.userId) filters.push(eq(operationalEvents.userId, query.userId));
  if (query.since) filters.push(gte(operationalEvents.occurredAt, query.since));
  if (query.before) filters.push(lt(operationalEvents.occurredAt, query.before));
  if (query.q) {
    const pattern = `%${query.q.slice(0, 100)}%`;
    filters.push(
      or(
        ilike(operationalEvents.message, pattern),
        ilike(operationalEvents.eventType, pattern),
        ilike(operationalEvents.correlationId, pattern)
      )!
    );
  }

  const rows = await db
    .select()
    .from(operationalEvents)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(operationalEvents.occurredAt), desc(operationalEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    rows: pageRows,
    hasMore,
    nextBefore:
      hasMore && pageRows.length > 0
        ? pageRows[pageRows.length - 1].occurredAt.toISOString()
        : null,
  };
}

export type ReliabilitySummary = {
  total: number;
  failures: number;
  warnings: number;
  previousFailures: number;
};

export async function getReliabilitySummary(
  windowStart: Date,
  previousStart: Date
): Promise<ReliabilitySummary> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE occurred_at >= ${windowStart})::int AS total,
      COUNT(*) FILTER (WHERE occurred_at >= ${windowStart} AND severity = 'error')::int AS failures,
      COUNT(*) FILTER (WHERE occurred_at >= ${windowStart} AND severity = 'warn')::int AS warnings,
      COUNT(*) FILTER (
        WHERE occurred_at >= ${previousStart}
          AND occurred_at < ${windowStart}
          AND severity = 'error'
      )::int AS previous_failures
    FROM operational_events
  `);
  const row = rowsOf<{
    total: number | string;
    failures: number | string;
    warnings: number | string;
    previous_failures: number | string;
  }>(result)[0];
  return {
    total: Number(row?.total ?? 0),
    failures: Number(row?.failures ?? 0),
    warnings: Number(row?.warnings ?? 0),
    previousFailures: Number(row?.previous_failures ?? 0),
  };
}

export type OperationalTrendPoint = {
  bucketStart: Date;
  total: number;
  errors: number;
  warnings: number;
};

export async function operationalEventTrend(
  days: number,
  now = new Date()
): Promise<OperationalTrendPoint[]> {
  const db = await getDb();
  const safeDays = Math.min(Math.max(days, 1), 90);
  const since = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
  const result = await db.execute(sql`
    SELECT
      date_trunc('day', occurred_at) AS bucket_start,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE severity = 'error')::int AS errors,
      COUNT(*) FILTER (WHERE severity = 'warn')::int AS warnings
    FROM operational_events
    WHERE occurred_at >= ${since}
    GROUP BY 1
    ORDER BY 1
  `);
  return rowsOf<{
    bucket_start: Date | string;
    total: number | string;
    errors: number | string;
    warnings: number | string;
  }>(result).map((row) => ({
    bucketStart:
      row.bucket_start instanceof Date
        ? row.bucket_start
        : new Date(row.bucket_start),
    total: Number(row.total),
    errors: Number(row.errors),
    warnings: Number(row.warnings),
  }));
}

export async function pruneOperationalEvents(
  olderThan = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
): Promise<number> {
  const db = await getDb();
  const removed = await db
    .delete(operationalEvents)
    .where(lt(operationalEvents.occurredAt, olderThan))
    .returning();
  return removed.length;
}
