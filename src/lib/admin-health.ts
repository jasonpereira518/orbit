import { and, desc, eq, gt, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  calendarSubscriptions,
  gmailConnections,
  imports,
  outlookConnections,
  usageEvents,
  userSettings,
} from "@/db/schema";

/**
 * Cross-user operational triage: what is broken across every account, right now.
 *
 * The inspector has always shown this per account, which means a dead Gmail token is only
 * visible if you happen to open the one page it lives on. Nobody opens two hundred pages.
 * These are the same predicates the inspector applies, lifted so the two screens cannot
 * drift, and grouped by the question they answer rather than by the table they came from.
 *
 * REDACTION: every arm selects status and metadata only. The connection rows carry the
 * *user's own* email address — the account identity, not a third party's — and never the
 * encrypted access or refresh tokens. Import error strings, calendar sync errors and AI
 * error kinds are system output, so they are shown verbatim, which is the same rule the
 * inspector already applies.
 */

/** `usage_events` is pruned at 180 days by the process-stalled cron; no window may exceed it. */
export const USAGE_EVENT_RETENTION_DAYS = 180;

/** An import sitting in `processing` this long is stuck, not slow. */
const STALLED_IMPORT_MS = 10 * 60 * 1000;

export type ConnectionHealthRow = {
  userId: string;
  email: string | null;
  provider: "gmail" | "outlook";
  /** The account's own address. Not third-party data. */
  connectionEmail: string;
  status: string;
  reason: "status" | "expired";
  tokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
};

export type CalendarHealthRow = {
  subscriptionId: string;
  userId: string;
  email: string | null;
  label: string | null;
  enabled: boolean;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncedAt: Date | null;
};

export type ImportHealthRow = {
  importId: string;
  userId: string;
  email: string | null;
  importType: string;
  fileName: string | null;
  status: string;
  stalled: boolean;
  totalRows: number | null;
  rowsProcessed: number | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AiErrorGroup = {
  errorKind: string;
  provider: string;
  model: string;
  operation: string;
  failures: number;
  /** Distinct accounts hit. This is what separates a provider outage from one bad key. */
  accounts: number;
  lastAt: Date | null;
};

export type AdminHealth = {
  connections: ConnectionHealthRow[];
  calendars: CalendarHealthRow[];
  imports: ImportHealthRow[];
  aiErrors: AiErrorGroup[];
  aiFailureTotal: number;
  aiAccountsAffected: number;
  windowDays: number;
  /** Accounts with no key for the provider they selected — every AI feature fails for them. */
  missingKeyAccounts: Array<{ userId: string; email: string | null; provider: string }>;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Gmail and Outlook are structurally identical here, so one query shape serves both. */
async function connectionsFor(
  provider: "gmail" | "outlook",
  now: Date
): Promise<ConnectionHealthRow[]> {
  const db = await getDb();
  const table = provider === "gmail" ? gmailConnections : outlookConnections;

  const rows = await db
    .select({
      userId: table.userId,
      email: userSettings.email,
      connectionEmail: table.emailAddress,
      status: table.status,
      tokenExpiresAt: table.tokenExpiresAt,
      lastSyncedAt: table.lastSyncedAt,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .leftJoin(userSettings, eq(userSettings.userId, table.userId))
    .where(
      or(
        ne(table.status, "active"),
        and(isNotNull(table.tokenExpiresAt), lt(table.tokenExpiresAt, now))
      )
    )
    .orderBy(desc(table.updatedAt));

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    provider,
    connectionEmail: r.connectionEmail,
    status: r.status,
    reason: r.status !== "active" ? ("status" as const) : ("expired" as const),
    tokenExpiresAt: r.tokenExpiresAt,
    lastSyncedAt: r.lastSyncedAt,
    updatedAt: r.updatedAt,
  }));
}

export async function failingConnections(
  now: Date = new Date()
): Promise<ConnectionHealthRow[]> {
  const [gmail, outlook] = await Promise.all([
    connectionsFor("gmail", now),
    connectionsFor("outlook", now),
  ]);
  return [...gmail, ...outlook].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );
}

export async function failingCalendarFeeds(): Promise<CalendarHealthRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      subscriptionId: calendarSubscriptions.id,
      userId: calendarSubscriptions.userId,
      email: userSettings.email,
      label: calendarSubscriptions.label,
      enabled: calendarSubscriptions.enabled,
      lastSyncStatus: calendarSubscriptions.lastSyncStatus,
      lastSyncError: calendarSubscriptions.lastSyncError,
      lastSyncedAt: calendarSubscriptions.lastSyncedAt,
    })
    .from(calendarSubscriptions)
    .leftJoin(userSettings, eq(userSettings.userId, calendarSubscriptions.userId))
    .where(eq(calendarSubscriptions.lastSyncStatus, "error"))
    .orderBy(desc(calendarSubscriptions.lastSyncedAt));

  return rows.map((r) => ({
    ...r,
    enabled: Boolean(r.enabled),
    lastSyncedAt: toDate(r.lastSyncedAt),
  }));
}

/** Failed imports, plus any sitting in `processing` long enough to count as stuck. */
export async function troubledImports(
  now: Date = new Date()
): Promise<ImportHealthRow[]> {
  const db = await getDb();
  const stalledBefore = new Date(now.getTime() - STALLED_IMPORT_MS);

  const rows = await db
    .select({
      importId: imports.id,
      userId: imports.userId,
      email: userSettings.email,
      importType: imports.importType,
      fileName: imports.fileName,
      status: imports.status,
      totalRows: imports.totalRows,
      rowsProcessed: imports.rowsProcessed,
      errorMessage: imports.errorMessage,
      createdAt: imports.createdAt,
      updatedAt: imports.updatedAt,
    })
    .from(imports)
    .leftJoin(userSettings, eq(userSettings.userId, imports.userId))
    .where(
      or(
        eq(imports.status, "failed"),
        and(eq(imports.status, "processing"), lt(imports.updatedAt, stalledBefore))
      )
    )
    .orderBy(desc(imports.updatedAt))
    .limit(100);

  return rows.map((r) => ({
    ...r,
    stalled: r.status === "processing",
  }));
}

/**
 * AI failures grouped by `error_kind x provider/model x operation`, with a distinct-account
 * count per group.
 *
 * The account count is the point. Forty auth failures across one account is a user who
 * pasted a bad key; forty across thirty accounts is the provider, and the two need
 * completely different responses.
 */
export async function aiErrorBreakdown(
  days = 30,
  now: Date = new Date()
): Promise<AiErrorGroup[]> {
  const db = await getDb();
  const window = Math.min(days, USAGE_EVENT_RETENTION_DAYS);
  const since = new Date(now.getTime() - window * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      errorKind: usageEvents.errorKind,
      provider: usageEvents.provider,
      model: usageEvents.model,
      operation: usageEvents.operation,
      failures: sql<number>`count(*)::int`,
      accounts: sql<number>`count(distinct ${usageEvents.userId})::int`,
      lastAt: sql<string | null>`max(${usageEvents.createdAt})`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.success, 0), gt(usageEvents.createdAt, since)))
    .groupBy(
      usageEvents.errorKind,
      usageEvents.provider,
      usageEvents.model,
      usageEvents.operation
    );

  return rows
    .map((r) => ({
      errorKind: r.errorKind ?? "other",
      provider: r.provider,
      model: r.model,
      operation: r.operation,
      failures: num(r.failures),
      accounts: num(r.accounts),
      lastAt: toDate(r.lastAt),
    }))
    .sort((a, b) => b.failures - a.failures);
}

/**
 * Accounts that cannot use AI at all, because no key exists for the provider they selected.
 *
 * Production is strictly BYOK, so these accounts hit a hard error on their first capture.
 * The inspector calls this the highest-value signal in the console; it belongs on a
 * cross-account screen for the same reason.
 */
export async function accountsMissingProviderKey(): Promise<
  Array<{ userId: string; email: string | null; provider: string }>
> {
  const db = await getDb();
  // Presence only. The encrypted blobs are never selected into an admin surface.
  const hasKey = sql`
    CASE coalesce(${userSettings.aiProvider}, 'gemini')
      WHEN 'openai' THEN ${userSettings.openaiApiKeyEncrypted} IS NOT NULL
      WHEN 'anthropic' THEN ${userSettings.anthropicApiKeyEncrypted} IS NOT NULL
      ELSE ${userSettings.geminiApiKeyEncrypted} IS NOT NULL
    END`;

  // Filtered in SQL rather than pulled into JS and filtered there — this used to select
  // every account on every `/admin/health` load just to throw most rows away.
  return db
    .select({
      userId: userSettings.userId,
      email: userSettings.email,
      provider: sql<string>`coalesce(${userSettings.aiProvider}, 'gemini')`,
    })
    .from(userSettings)
    .where(sql`NOT (${hasKey})`);
}

export async function getAdminHealth(
  opts: { now?: Date; windowDays?: number } = {}
): Promise<AdminHealth> {
  const now = opts.now ?? new Date();
  const windowDays = Math.min(
    opts.windowDays ?? 30,
    USAGE_EVENT_RETENTION_DAYS
  );

  const [connections, calendars, importRows, aiErrors, missingKeyAccounts] =
    await Promise.all([
      failingConnections(now),
      failingCalendarFeeds(),
      troubledImports(now),
      aiErrorBreakdown(windowDays, now),
      accountsMissingProviderKey(),
    ]);

  return {
    connections,
    calendars,
    imports: importRows,
    aiErrors,
    aiFailureTotal: aiErrors.reduce((acc, g) => acc + g.failures, 0),
    // Groups overlap on accounts, so this is a floor, not a sum. Named accordingly in the UI.
    aiAccountsAffected: aiErrors.reduce((acc, g) => Math.max(acc, g.accounts), 0),
    windowDays,
    missingKeyAccounts,
  };
}
