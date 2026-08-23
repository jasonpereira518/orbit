import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { getDb, isPgvectorAvailable, rowsOf } from "@/db";
import {
  calendarSubscriptions,
  cronRuns,
  errorEvents,
  gmailConnections,
  importJobRows,
  imports,
  outlookConnections,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  suggestedReminders,
  usageEvents,
  userSettings,
  webhookDeliveries,
} from "@/db/schema";
import { countInt, num, toDate } from "@/lib/admin-metrics";
import { PLAN_LIMIT_ROW_REASON } from "@/lib/import-job-processor";
import { deriveCronRunState, hasMissedRun, type CronRunState } from "@/lib/cron-runs";

/**
 * System-level reads for `/admin/ops`.
 *
 * The split this module enforces: **the Overview lists things that name a person; Ops lists
 * things that name a system.** If the fix is "message this user" it belongs in
 * `buildAlerts`; if the fix is "go fix Orbit" it belongs here. Nothing in this file calls
 * `buildAlerts`, and `OpsSignal` deliberately has no top-level `userId`, so a person-alert
 * cannot be rendered on Ops by accident.
 *
 * Almost none of these are `GROUP BY user_id` — they are global counts by status, so their
 * cost is independent of user count.
 */

/**
 * A client-driven import untouched for this long is abandoned. Deliberately DIFFERENT from
 * `CRON_STALL_THRESHOLD_MS` (3 min) in the process-stalled route: that one means "the cron
 * will pick this up", this one means "nothing ever will". The two thresholds mark the two
 * ownership classes and must not be reconciled.
 */
export const WEDGED_IMPORT_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type StuckImport = {
  id: string;
  userId: string;
  email: string | null;
  importType: string;
  fileName: string | null;
  status: string;
  rowsProcessed: number | null;
  totalRows: number | null;
  errorMessage: string | null;
  updatedAt: Date;
};

export type OpsImports = {
  /** Client-driven and abandoned — the cron filters on import_type and will never see these. */
  wedged: StuckImport[];
  /** Server-owned; the nightly cron will resume these, but not for up to 24 hours. */
  awaitingCron: StuckImport[];
  failed: StuckImport[];
  /** Rows refused by the plan cap, per import. An upgrade signal, not an error. */
  planBlockedByImport: Map<string, number>;
};

export type OpsOutreachQueue = {
  overdue: number;
  notYetDue: number;
  oldestOverdue: Date | null;
  /** Age of the oldest overdue message in days. Computed here because `now` is a
   *  parameter of this function, whereas calling Date.now() during render is impure. */
  oldestOverdueDays: number | null;
  accounts: number;
};

export type OpsConnections = {
  needsReauth: number;
  healthy: number;
  byProvider: Array<{ provider: string; status: string; count: number }>;
};

export type OpsCalendar = {
  erroring: number;
  neverSynced: number;
  /** Stale feeds, annotated with how long the owner has been gone. */
  stale: Array<{ userId: string; email: string | null; lastSyncedAt: Date | null; ownerLastSeen: Date | null }>;
  recentErrors: Array<{ label: string | null; error: string | null; at: Date | null }>;
};

export type OpsCron = {
  lastRun: {
    job: string;
    state: CronRunState;
    startedAt: Date;
    durationMs: number | null;
    stats: Record<string, number | boolean>;
    error: string | null;
  } | null;
  missed: boolean;
  recent: Array<{
    id: string;
    state: CronRunState;
    startedAt: Date;
    durationMs: number | null;
    stats: Record<string, number | boolean>;
    error: string | null;
  }>;
};

export type OpsAiFailures = {
  /** Orbit's problem: timeouts, empty responses, unavailable models. */
  ours: Array<{ kind: string; count: number }>;
  /** The user's problem: bad keys, their own rate limits. */
  theirs: Array<{ kind: string; count: number }>;
  totalCalls: number;
  slowest: Array<{ operation: string; maxMs: number }>;
};

export type OpsErrors = {
  grouped: Array<{ source: string; kind: string; count: number; lastAt: Date | null }>;
  recent: Array<{ source: string; kind: string; message: string | null; at: Date }>;
};

export type OpsWebhooks = {
  byOutcome: Array<{ outcome: string; count: number }>;
  ignored: Array<{ eventType: string | null; reason: string | null; count: number }>;
  retried: Array<{ eventId: string; count: number }>;
  recentInvalid: Array<{ eventId: string | null; error: string | null; at: Date }>;
};

export type OpsBugSignatures = {
  confirmedWithoutReminder: number;
  /** Rows the semantic index cannot see. Null when pgvector is unavailable (local dev). */
  embeddingsMissingVector: number | null;
  inlinedAvatars: number;
};

/** `usage_events.error_kind` values that mean Orbit broke, not the user's key. */
const OUR_ERROR_KINDS = new Set(["timeout", "empty_response", "model_unavailable", "other"]);

export async function getOpsImports(now = new Date()): Promise<OpsImports> {
  const db = await getDb();
  const wedgedBefore = new Date(now.getTime() - WEDGED_IMPORT_MS);
  const failedSince = new Date(now.getTime() - 7 * DAY_MS);

  const emails = new Map(
    (
      await db
        .select({ userId: userSettings.userId, email: userSettings.email })
        .from(userSettings)
    ).map((r) => [r.userId, r.email])
  );

  const shape = {
    id: imports.id,
    userId: imports.userId,
    importType: imports.importType,
    fileName: imports.fileName,
    status: imports.status,
    rowsProcessed: imports.rowsProcessed,
    totalRows: imports.totalRows,
    errorMessage: imports.errorMessage,
    updatedAt: imports.updatedAt,
  };

  // `imports` has no status index. It is a small table and adding one now is premature;
  // revisit if this page ever gets slow.
  const [wedgedRows, awaitingRows, failedRows] = await Promise.all([
    db
      .select(shape)
      .from(imports)
      .where(
        and(
          eq(imports.status, "processing"),
          ne(imports.importType, "linkedin_connections"),
          lt(imports.updatedAt, wedgedBefore)
        )
      )
      .orderBy(imports.updatedAt)
      .limit(25),
    db
      .select(shape)
      .from(imports)
      .where(
        and(
          eq(imports.status, "processing"),
          eq(imports.importType, "linkedin_connections"),
          lt(imports.updatedAt, wedgedBefore)
        )
      )
      .orderBy(imports.updatedAt)
      .limit(25),
    db
      .select(shape)
      .from(imports)
      .where(and(eq(imports.status, "failed"), gt(imports.updatedAt, failedSince)))
      .orderBy(desc(imports.updatedAt))
      .limit(25),
  ]);

  const decorate = (rows: typeof wedgedRows): StuckImport[] =>
    rows.map((r) => ({ ...r, email: emails.get(r.userId) ?? null }));

  // Row detail ONLY for the imports actually rendered — never a global scan of
  // import_job_rows, which is the largest table in the database on a big LinkedIn export.
  const renderedIds = [...wedgedRows, ...awaitingRows, ...failedRows].map((r) => r.id);
  const planBlockedByImport = new Map<string, number>();
  if (renderedIds.length > 0) {
    const blocked = await db
      .select({ importId: importJobRows.importId, n: countInt })
      .from(importJobRows)
      .where(
        and(
          inArray(importJobRows.importId, renderedIds),
          eq(importJobRows.errorMessage, PLAN_LIMIT_ROW_REASON)
        )
      )
      .groupBy(importJobRows.importId);
    for (const row of blocked) planBlockedByImport.set(row.importId, row.n);
  }

  return {
    wedged: decorate(wedgedRows),
    awaitingCron: decorate(awaitingRows),
    failed: decorate(failedRows),
    planBlockedByImport,
  };
}

export async function getOpsOutreachQueue(now = new Date()): Promise<OpsOutreachQueue> {
  const db = await getDb();

  // outreach_messages has no user_id: it joins message → prospect → campaign.user_id.
  // Only ids and timestamps are selected — prospect and message bodies are third-party
  // prose and must never reach an admin surface.
  const rows = await db
    .select({
      userId: outreachCampaigns.userId,
      scheduledFor: outreachMessages.scheduledFor,
    })
    .from(outreachMessages)
    .innerJoin(outreachProspects, eq(outreachProspects.id, outreachMessages.prospectId))
    .innerJoin(outreachCampaigns, eq(outreachCampaigns.id, outreachProspects.campaignId))
    .where(eq(outreachMessages.status, "scheduled"));

  let overdue = 0;
  let notYetDue = 0;
  let oldest: Date | null = null;
  const accounts = new Set<string>();

  for (const row of rows) {
    const due = toDate(row.scheduledFor);
    if (due && due.getTime() < now.getTime()) {
      overdue += 1;
      accounts.add(row.userId);
      if (!oldest || due.getTime() < oldest.getTime()) oldest = due;
    } else {
      notYetDue += 1;
    }
  }

  return {
    overdue,
    notYetDue,
    oldestOverdue: oldest,
    oldestOverdueDays: oldest
      ? Math.round((now.getTime() - oldest.getTime()) / DAY_MS)
      : null,
    accounts: accounts.size,
  };
}

export async function getOpsConnections(): Promise<OpsConnections> {
  const db = await getDb();

  const [gmail, outlook] = await Promise.all([
    db
      .select({ status: gmailConnections.status, n: countInt })
      .from(gmailConnections)
      .groupBy(gmailConnections.status),
    db
      .select({ status: outlookConnections.status, n: countInt })
      .from(outlookConnections)
      .groupBy(outlookConnections.status),
  ]);

  const byProvider = [
    ...gmail.map((r) => ({ provider: "Gmail", status: r.status, count: r.n })),
    ...outlook.map((r) => ({ provider: "Outlook", status: r.status, count: r.n })),
  ];

  return {
    needsReauth: byProvider
      .filter((r) => r.status !== "active")
      .reduce((a, r) => a + r.count, 0),
    healthy: byProvider
      .filter((r) => r.status === "active")
      .reduce((a, r) => a + r.count, 0),
    byProvider,
  };
}

export async function getOpsCalendar(now = new Date()): Promise<OpsCalendar> {
  const db = await getDb();
  const staleBefore = new Date(now.getTime() - 7 * DAY_MS);

  const [counts, staleRows, errorRows] = await Promise.all([
    db
      .select({
        erroring: sql<string>`count(*) filter (where ${calendarSubscriptions.lastSyncStatus} = 'error')`,
        neverSynced: sql<string>`count(*) filter (where ${calendarSubscriptions.enabled} = 1 and ${calendarSubscriptions.lastSyncedAt} is null)`,
      })
      .from(calendarSubscriptions),
    // Joined to the owner's last-seen on purpose: sync only fires when someone loads the
    // dashboard or imports page, so a stale feed nearly always means an inactive user
    // rather than a broken feed. Without this the number reads as alarming and isn't.
    db
      .select({
        userId: calendarSubscriptions.userId,
        email: userSettings.email,
        lastSyncedAt: calendarSubscriptions.lastSyncedAt,
        ownerLastSeen: userSettings.lastActiveAt,
      })
      .from(calendarSubscriptions)
      .leftJoin(userSettings, eq(userSettings.userId, calendarSubscriptions.userId))
      .where(
        and(
          eq(calendarSubscriptions.enabled, 1),
          isNotNull(calendarSubscriptions.lastSyncedAt),
          lt(calendarSubscriptions.lastSyncedAt, staleBefore)
        )
      )
      .limit(20),
    db
      .select({
        label: calendarSubscriptions.label,
        error: calendarSubscriptions.lastSyncError,
        at: calendarSubscriptions.lastSyncedAt,
      })
      .from(calendarSubscriptions)
      .where(eq(calendarSubscriptions.lastSyncStatus, "error"))
      .limit(10),
  ]);

  return {
    erroring: num(counts[0]?.erroring),
    neverSynced: num(counts[0]?.neverSynced),
    stale: staleRows.map((r) => ({
      userId: r.userId,
      email: r.email ?? null,
      lastSyncedAt: toDate(r.lastSyncedAt),
      ownerLastSeen: toDate(r.ownerLastSeen),
    })),
    recentErrors: errorRows.map((r) => ({
      label: r.label,
      error: r.error,
      at: toDate(r.at),
    })),
  };
}

export async function getOpsCron(now = new Date()): Promise<OpsCron> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(cronRuns)
    .orderBy(desc(cronRuns.startedAt))
    .limit(10);

  const recent = rows.map((r) => ({
    id: r.id,
    state: deriveCronRunState(r, now),
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    stats: r.stats ?? {},
    error: r.error,
  }));

  const latest = rows[0];
  return {
    lastRun: latest
      ? {
          job: latest.job,
          state: deriveCronRunState(latest, now),
          startedAt: latest.startedAt,
          durationMs: latest.durationMs,
          stats: latest.stats ?? {},
          error: latest.error,
        }
      : null,
    missed: hasMissedRun(latest?.startedAt ?? null, now),
    recent,
  };
}

export async function getOpsAiFailures(days = 7, now = new Date()): Promise<OpsAiFailures> {
  const db = await getDb();
  const since = new Date(now.getTime() - days * DAY_MS);

  const [failures, totals, slowest] = await Promise.all([
    db
      .select({ kind: usageEvents.errorKind, n: countInt })
      .from(usageEvents)
      .where(and(eq(usageEvents.success, 0), gt(usageEvents.createdAt, since)))
      .groupBy(usageEvents.errorKind),
    db
      .select({ n: countInt })
      .from(usageEvents)
      .where(gt(usageEvents.createdAt, since)),
    // max, not avg or p95: there is no percentile helper, and mean latency changes no
    // decision. Max is what catches "transcription takes 94s and users think it hung".
    db
      .select({
        operation: usageEvents.operation,
        maxMs: sql<string>`coalesce(max(${usageEvents.durationMs}), 0)`,
      })
      .from(usageEvents)
      .where(gt(usageEvents.createdAt, since))
      .groupBy(usageEvents.operation)
      .orderBy(desc(sql`coalesce(max(${usageEvents.durationMs}), 0)`))
      .limit(5),
  ]);

  const ours: Array<{ kind: string; count: number }> = [];
  const theirs: Array<{ kind: string; count: number }> = [];
  for (const row of failures) {
    const kind = row.kind ?? "other";
    (OUR_ERROR_KINDS.has(kind) ? ours : theirs).push({ kind, count: row.n });
  }
  const bySize = (a: { count: number }, b: { count: number }) => b.count - a.count;

  return {
    ours: ours.sort(bySize),
    theirs: theirs.sort(bySize),
    totalCalls: totals[0]?.n ?? 0,
    slowest: slowest.map((r) => ({ operation: r.operation, maxMs: num(r.maxMs) })),
  };
}

export async function getOpsErrors(days = 7, now = new Date()): Promise<OpsErrors> {
  const db = await getDb();
  const since = new Date(now.getTime() - days * DAY_MS);

  const [grouped, recent] = await Promise.all([
    db
      .select({
        source: errorEvents.source,
        kind: errorEvents.kind,
        n: countInt,
        lastAt: sql<string | null>`max(${errorEvents.createdAt})`,
      })
      .from(errorEvents)
      .where(gt(errorEvents.createdAt, since))
      .groupBy(errorEvents.source, errorEvents.kind),
    db
      .select({
        source: errorEvents.source,
        kind: errorEvents.kind,
        message: errorEvents.message,
        at: errorEvents.createdAt,
      })
      .from(errorEvents)
      .where(gt(errorEvents.createdAt, since))
      .orderBy(desc(errorEvents.createdAt))
      .limit(20),
  ]);

  return {
    grouped: grouped
      .map((r) => ({
        source: r.source,
        kind: r.kind,
        count: r.n,
        lastAt: toDate(r.lastAt),
      }))
      .sort((a, b) => b.count - a.count),
    recent,
  };
}

export async function getOpsWebhooks(days = 7, now = new Date()): Promise<OpsWebhooks> {
  const db = await getDb();
  const since = new Date(now.getTime() - days * DAY_MS);

  const [byOutcome, ignored, retried, recentInvalid] = await Promise.all([
    db
      .select({ outcome: webhookDeliveries.outcome, n: countInt })
      .from(webhookDeliveries)
      .where(gt(webhookDeliveries.createdAt, since))
      .groupBy(webhookDeliveries.outcome),
    db
      .select({
        eventType: webhookDeliveries.eventType,
        reason: webhookDeliveries.reason,
        n: countInt,
      })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.outcome, "ignored"), gt(webhookDeliveries.createdAt, since)))
      .groupBy(webhookDeliveries.eventType, webhookDeliveries.reason),
    // Only possible because there is no unique index on (source, event_id) — a repeated
    // delivery id means the handler kept failing and Svix kept retrying.
    db
      .select({ eventId: webhookDeliveries.eventId, n: countInt })
      .from(webhookDeliveries)
      .where(and(isNotNull(webhookDeliveries.eventId), gt(webhookDeliveries.createdAt, since)))
      .groupBy(webhookDeliveries.eventId)
      .having(sql`count(*) > 1`)
      .limit(10),
    db
      .select({
        eventId: webhookDeliveries.eventId,
        error: webhookDeliveries.error,
        at: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.outcome, "invalid"), gt(webhookDeliveries.createdAt, since)))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(10),
  ]);

  return {
    byOutcome: byOutcome.map((r) => ({ outcome: r.outcome, count: r.n })),
    ignored: ignored.map((r) => ({
      eventType: r.eventType,
      reason: r.reason,
      count: r.n,
    })),
    retried: retried
      .filter((r): r is { eventId: string; n: number } => Boolean(r.eventId))
      .map((r) => ({ eventId: r.eventId, count: r.n })),
    recentInvalid,
  };
}

export async function getOpsBugSignatures(): Promise<OpsBugSignatures> {
  const db = await getDb();

  const [confirmed, inlined] = await Promise.all([
    // A confirm that wrote its status but never landed the reminder row. A code bug, not
    // a data-quality problem — hence Ops rather than Product.
    db
      .select({ n: countInt })
      .from(suggestedReminders)
      .where(
        and(
          eq(suggestedReminders.status, "confirmed"),
          isNull(suggestedReminders.reminderId)
        )
      ),
    // Measures the harm of an unconfigured Blob store directly, instead of logging the
    // config fact once per cold start: these are base64 images living in Postgres.
    db.execute(
      sql`SELECT count(*)::int AS n FROM contacts WHERE profile_image_url LIKE 'data:%'`
    ),
  ]);

  let embeddingsMissingVector: number | null = null;
  if (isPgvectorAvailable()) {
    try {
      // Raw SQL: `embedding_vector` is created by migratePgvector at runtime, is absent
      // from schema.ts, and does not exist at all on PGlite. Rows with a null vector are
      // invisible to semantic search and nothing else reports them.
      const res = await db.execute(
        sql`SELECT count(*)::int AS n FROM contact_embeddings WHERE embedding_vector IS NULL`
      );
      embeddingsMissingVector = rowsOf<{ n: number }>(res)[0]?.n ?? 0;
    } catch {
      embeddingsMissingVector = null;
    }
  }

  return {
    confirmedWithoutReminder: confirmed[0]?.n ?? 0,
    embeddingsMissingVector,
    inlinedAvatars: rowsOf<{ n: number }>(inlined)[0]?.n ?? 0,
  };
}

/**
 * The Overview's `· N system issues` counter.
 *
 * Several scalar subqueries in ONE round trip, because this runs on a page that already
 * does its own fan-out and must not pay for nine more queries.
 */
export async function getOpsHeadlineCount(now = new Date()): Promise<number> {
  const db = await getDb();
  const wedgedBefore = new Date(now.getTime() - WEDGED_IMPORT_MS).toISOString();

  try {
    const res = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM imports
          WHERE status = 'processing'
            AND import_type <> 'linkedin_connections'
            AND updated_at < ${wedgedBefore})::int AS wedged,
        (SELECT count(*) FROM outreach_messages
          WHERE status = 'scheduled' AND scheduled_for < now())::int AS overdue,
        (SELECT count(*) FROM calendar_subscriptions
          WHERE last_sync_status = 'error')::int AS calendar_errors,
        (SELECT count(*) FROM gmail_connections WHERE status <> 'active')::int
          + (SELECT count(*) FROM outlook_connections WHERE status <> 'active')::int
          AS needs_reauth
    `);
    const row = rowsOf<{
      wedged: number;
      overdue: number;
      calendar_errors: number;
      needs_reauth: number;
    }>(res)[0];
    if (!row) return 0;
    return (
      num(row.wedged) + num(row.overdue) + num(row.calendar_errors) + num(row.needs_reauth)
    );
  } catch {
    // The Overview must render even if this one extra query fails.
    return 0;
  }
}
