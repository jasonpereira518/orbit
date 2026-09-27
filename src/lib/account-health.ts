import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  appleConnections,
  calendarSubscriptions,
  contacts,
  gmailConnections,
  imports,
  outlookConnections,
  userSettings,
} from "@/db/schema";
import { aiReadyFromSettings } from "@/lib/ai-access";
import { resolveAiProvider } from "@/lib/ai-providers";
import {
  IMPORT_ALERT_WINDOW_MS,
  MAX_ACCOUNT_ALERTS,
  STALLED_IMPORT_MS,
  evaluateAccountHealth,
  hasErrorAlert,
  sortAccountAlerts,
  toAccountAlerts,
  type AccountAlert,
  type ConnectionFacts,
  type HealthInput,
} from "@/lib/account-alerts";
import { entitlementsFromSettings, type Entitlements } from "@/lib/entitlements";
import { deriveConnectionHealth } from "@/lib/connection-status";
import { getGmailOAuthConfigSummary, hasCalendarScope } from "@/lib/gmail";
import {
  getOutlookOAuthConfigSummary,
  hasCalendarScope as hasOutlookCalendarScope,
} from "@/lib/outlook";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { ensureUserSettings } from "@/lib/user-settings";

/**
 * The server half of account alerts: loads the facts, hands them to the pure predicates in
 * `account-alerts.ts`, and filters the result for this particular viewer.
 *
 * COST. This runs on the notifications panel's 120-second poll, so every fact it needs is
 * either already in hand or folded into one statement. Provider, key presence, onboarding,
 * subscription state, plan and `contactLimit` come from the settings row — the caller's
 * (`AccountHealthContext`), or else `ensureUserSettings`, a React `cache()` memo — and
 * `entitlementsFromSettings` on that same row, which reads nothing. Surface visibility is a
 * second memo the app shell already uses. Everything else is scalar subqueries in a SINGLE
 * `select`, the pattern `admin-user-detail.ts` uses and for the reason it gives there: on
 * Neon HTTP every separate query is its own round trip, and one statement the planner runs
 * as a handful of index lookups is the same work at a fraction of the latency.
 *
 * Measured (`scripts/smoke-account-alerts.ts`, case 19): at most 4 statements called
 * standalone with no request context, where the `cache()` memos cannot help. Inside a
 * request that has already resolved settings and surface visibility (or passes the row in),
 * the marginal cost is the one combined select. A paid account never pays for the contact count.
 *
 * FRESHNESS. Alerts clear on the next poll, on panel open, or after any panel mutation —
 * so the bell's dot can outlive the fix by up to 120 seconds. That is deliberate and is
 * not worth a faster poll; the panel is not a monitoring console.
 */

/** Booleans arrive from PGlite and Neon in different shapes; normalise before trusting them. */
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true";
}

/** `count(*)::int` is not guaranteed to arrive as a JS number on both drivers. */
function num(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** timestamptz can come back as a string. */
function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function connectionFacts(
  configured: boolean,
  status: unknown,
  emailAddress: unknown,
  tokenExpiresAt: unknown,
  hasRefreshToken: unknown
): ConnectionFacts | null {
  // No row means the user never connected, or disconnected (which deletes the row). No
  // OAuth app on this deployment means there is no reconnect flow to send them to, so an
  // alert would be a dead end — suppress it rather than nag about something unfixable.
  const resolved = text(status);
  if (!configured || !resolved) return null;
  return {
    status: resolved === "needs_reauth" ? "needs_reauth" : "active",
    emailAddress: text(emailAddress) ?? "",
    tokenExpiresAt: toDate(tokenExpiresAt),
    hasRefreshToken: bool(hasRefreshToken),
  };
}

function googleCalendarFacts(
  configured: boolean,
  status: unknown,
  nextSyncAt: unknown,
  syncError: unknown,
  scopes: unknown
): HealthInput["googleCalendar"] {
  const resolved = text(status);
  if (!configured || !resolved || !hasCalendarScope(text(scopes))) return null;
  const reason = text(syncError);
  return {
    paused:
      deriveConnectionHealth({
        status: resolved,
        nextSyncAt: toDate(nextSyncAt),
        syncError: reason,
        calendarScopeGranted: true,
      }) === "disarmed",
    reason,
  };
}

/** Mirrors `googleCalendarFacts` exactly, for the Outlook grant instead of the Gmail one. */
function microsoftCalendarFacts(
  configured: boolean,
  status: unknown,
  nextSyncAt: unknown,
  syncError: unknown,
  scopes: unknown
): HealthInput["microsoftCalendar"] {
  const resolved = text(status);
  if (!configured || !resolved || !hasOutlookCalendarScope(text(scopes))) return null;
  const reason = text(syncError);
  return {
    paused:
      deriveConnectionHealth({
        status: resolved,
        nextSyncAt: toDate(nextSyncAt),
        syncError: reason,
        calendarScopeGranted: true,
      }) === "disarmed",
    reason,
  };
}

/**
 * Unlike `googleCalendarFacts`/`microsoftCalendarFacts`, no `configured` gate (Apple has no
 * OAuth app to configure) and no scope check (Apple grants none — see
 * `apple_connections.scopes`'s own comment, and `account-alerts.ts`'s `appleCalendar` doc
 * comment for why a revoked app-specific password reads as the same "disarmed" state as a
 * sync that gave up on its own).
 */
function appleCalendarFacts(
  status: unknown,
  nextSyncAt: unknown,
  syncError: unknown
): HealthInput["appleCalendar"] {
  const resolved = text(status);
  if (!resolved) return null;
  const reason = text(syncError);
  return {
    paused:
      deriveConnectionHealth({
        status: resolved,
        nextSyncAt: toDate(nextSyncAt),
        syncError: reason,
        calendarScopeGranted: true,
      }) === "disarmed",
    reason,
  };
}

/**
 * The account's settings row and entitlements, for a caller that already holds them.
 *
 * Optional everywhere it is accepted. The app pulse is a Server Action, where `cache()` is a
 * pass-through: without this, `ensureUserSettings` and `getEntitlements` would each re-read
 * the row `requireAuthenticatedUser()` had just read, on a 90-second poll per tab.
 */
export type AccountHealthContext = {
  settings: typeof userSettings.$inferSelect;
  /** Resolved from `settings` when omitted — the same computation `getEntitlements` runs. */
  entitlements?: Entitlements;
};

export async function loadAccountHealthInput(
  userId: string,
  now: Date = new Date(),
  context?: AccountHealthContext
): Promise<HealthInput | null> {
  // `getEntitlements(userId)` is exactly `entitlementsFromSettings(userId, ensureUserSettings(userId))`,
  // so resolving from the row in hand is the same answer without a second read of it.
  const settings = context?.settings ?? (await ensureUserSettings(userId));
  if (!settings) return null;
  const entitlements = context?.entitlements ?? entitlementsFromSettings(userId, settings);

  const provider = resolveAiProvider(settings.aiProvider);
  const stalledBefore = new Date(now.getTime() - STALLED_IMPORT_MS);
  const importWindowStart = new Date(now.getTime() - IMPORT_ALERT_WINDOW_MS);
  // Paid accounts have no cap, so their contact count is never worth counting. Expressed
  // as a constant in SQL rather than a second query shape, so the statement stays static.
  const needContacts = entitlements.contactLimit !== null;

  const db = await getDb();
  const [row] = await db
    .select({
      gmailStatus: sql<string | null>`(
        SELECT ${gmailConnections.status} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailEmail: sql<string | null>`(
        SELECT ${gmailConnections.emailAddress} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailExpiresAt: sql<Date | string | null>`(
        SELECT ${gmailConnections.tokenExpiresAt} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailHasRefresh: sql<boolean | null>`(
        SELECT ${gmailConnections.refreshTokenEncrypted} IS NOT NULL FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailNextSyncAt: sql<Date | string | null>`(
        SELECT ${gmailConnections.nextSyncAt} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailSyncError: sql<string | null>`(
        SELECT ${gmailConnections.syncError} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailScopes: sql<string | null>`(
        SELECT ${gmailConnections.scopes} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,

      outlookStatus: sql<string | null>`(
        SELECT ${outlookConnections.status} FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,
      outlookEmail: sql<string | null>`(
        SELECT ${outlookConnections.emailAddress} FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,
      outlookExpiresAt: sql<Date | string | null>`(
        SELECT ${outlookConnections.tokenExpiresAt} FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,
      outlookHasRefresh: sql<boolean | null>`(
        SELECT ${outlookConnections.refreshTokenEncrypted} IS NOT NULL FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,
      outlookNextSyncAt: sql<Date | string | null>`(
        SELECT ${outlookConnections.nextSyncAt} FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,
      outlookSyncError: sql<string | null>`(
        SELECT ${outlookConnections.syncError} FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,
      outlookScopes: sql<string | null>`(
        SELECT ${outlookConnections.scopes} FROM ${outlookConnections}
        WHERE ${outlookConnections.userId} = ${userId} LIMIT 1)`,

      appleStatus: sql<string | null>`(
        SELECT ${appleConnections.status} FROM ${appleConnections}
        WHERE ${appleConnections.userId} = ${userId} LIMIT 1)`,
      appleNextSyncAt: sql<Date | string | null>`(
        SELECT ${appleConnections.nextSyncAt} FROM ${appleConnections}
        WHERE ${appleConnections.userId} = ${userId} LIMIT 1)`,
      appleSyncError: sql<string | null>`(
        SELECT ${appleConnections.syncError} FROM ${appleConnections}
        WHERE ${appleConnections.userId} = ${userId} LIMIT 1)`,

      // Disabled feeds are not syncing by choice; only an enabled one can be "failing".
      calendarErrorCount: sql<number>`(
        SELECT count(*)::int FROM ${calendarSubscriptions}
        WHERE ${calendarSubscriptions.userId} = ${userId}
          AND ${calendarSubscriptions.enabled} = 1
          AND ${calendarSubscriptions.lastSyncStatus} = 'error')`,
      calendarErrorLabel: sql<string | null>`(
        SELECT ${calendarSubscriptions.label} FROM ${calendarSubscriptions}
        WHERE ${calendarSubscriptions.userId} = ${userId}
          AND ${calendarSubscriptions.enabled} = 1
          AND ${calendarSubscriptions.lastSyncStatus} = 'error'
        ORDER BY ${calendarSubscriptions.lastSyncedAt} DESC NULLS LAST LIMIT 1)`,
      calendarErrorDetail: sql<string | null>`(
        SELECT ${calendarSubscriptions.lastSyncError} FROM ${calendarSubscriptions}
        WHERE ${calendarSubscriptions.userId} = ${userId}
          AND ${calendarSubscriptions.enabled} = 1
          AND ${calendarSubscriptions.lastSyncStatus} = 'error'
        ORDER BY ${calendarSubscriptions.lastSyncedAt} DESC NULLS LAST LIMIT 1)`,

      // Both import predicates are windowed. Alerts cannot be dismissed, so an unwindowed
      // historical row would be a permanent, unacknowledgeable badge.
      importFailedCount: sql<number>`(
        SELECT count(*)::int FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'failed'
          AND ${imports.updatedAt} > ${importWindowStart})`,
      importFailedLabel: sql<string | null>`(
        SELECT coalesce(${imports.fileName}, ${imports.importType}) FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'failed'
          AND ${imports.updatedAt} > ${importWindowStart}
        ORDER BY ${imports.updatedAt} DESC LIMIT 1)`,
      importFailedDetail: sql<string | null>`(
        SELECT ${imports.errorMessage} FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'failed'
          AND ${imports.updatedAt} > ${importWindowStart}
        ORDER BY ${imports.updatedAt} DESC LIMIT 1)`,
      importStalledCount: sql<number>`(
        SELECT count(*)::int FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'processing'
          AND ${imports.updatedAt} < ${stalledBefore}
          AND ${imports.updatedAt} > ${importWindowStart})`,
      importStalledLabel: sql<string | null>`(
        SELECT coalesce(${imports.fileName}, ${imports.importType}) FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'processing'
          AND ${imports.updatedAt} < ${stalledBefore}
          AND ${imports.updatedAt} > ${importWindowStart}
        ORDER BY ${imports.updatedAt} DESC LIMIT 1)`,
      importStalledRows: sql<number | null>`(
        SELECT ${imports.rowsProcessed} FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'processing'
          AND ${imports.updatedAt} < ${stalledBefore}
          AND ${imports.updatedAt} > ${importWindowStart}
        ORDER BY ${imports.updatedAt} DESC LIMIT 1)`,
      importStalledTotal: sql<number | null>`(
        SELECT ${imports.totalRows} FROM ${imports}
        WHERE ${imports.userId} = ${userId} AND ${imports.status} = 'processing'
          AND ${imports.updatedAt} < ${stalledBefore}
          AND ${imports.updatedAt} > ${importWindowStart}
        ORDER BY ${imports.updatedAt} DESC LIMIT 1)`,

      contactCount: needContacts
        ? sql<number>`(
            SELECT count(*)::int FROM ${contacts}
            WHERE ${contacts.userId} = ${userId})`
        : sql<number>`0`,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));

  if (!row) return null;

  return {
    aiProvider: provider,
    // The gate's own policy, presence-only: a Lifetime account on Orbit's key is not missing one.
    hasAiKey: aiReadyFromSettings(userId, settings),
    onboardingCompletedAt: toDate(settings.onboardingCompletedAt),

    gmail: connectionFacts(
      getGmailOAuthConfigSummary().configured,
      row.gmailStatus,
      row.gmailEmail,
      row.gmailExpiresAt,
      row.gmailHasRefresh
    ),
    outlook: connectionFacts(
      getOutlookOAuthConfigSummary().configured,
      row.outlookStatus,
      row.outlookEmail,
      row.outlookExpiresAt,
      row.outlookHasRefresh
    ),
    googleCalendar: googleCalendarFacts(
      getGmailOAuthConfigSummary().configured,
      row.gmailStatus,
      row.gmailNextSyncAt,
      row.gmailSyncError,
      row.gmailScopes
    ),
    microsoftCalendar: microsoftCalendarFacts(
      getOutlookOAuthConfigSummary().configured,
      row.outlookStatus,
      row.outlookNextSyncAt,
      row.outlookSyncError,
      row.outlookScopes
    ),
    appleCalendar: appleCalendarFacts(row.appleStatus, row.appleNextSyncAt, row.appleSyncError),

    calendarErrorCount: num(row.calendarErrorCount),
    calendarErrorLabel: text(row.calendarErrorLabel),
    calendarErrorDetail: text(row.calendarErrorDetail),

    importFailedCount: num(row.importFailedCount),
    importFailedLabel: text(row.importFailedLabel),
    importFailedDetail: text(row.importFailedDetail),
    importStalledCount: num(row.importStalledCount),
    importStalledLabel: text(row.importStalledLabel),
    importStalledRows: row.importStalledRows == null ? null : num(row.importStalledRows),
    importStalledTotal: row.importStalledTotal == null ? null : num(row.importStalledTotal),

    plan: entitlements.plan,
    planSource: entitlements.source,
    subscriptionStatus: settings.subscriptionStatus ?? null,
    subscriptionPeriodEnd: toDate(settings.subscriptionPeriodEnd),
    contactLimit: entitlements.contactLimit,
    contactCount: needContacts ? num(row.contactCount) : null,
  };
}

/**
 * The alerts this user should see, ordered, surface-filtered and capped.
 *
 * Never throws. A database hiccup in a decorative footer must not take out the reminders
 * the panel exists to show — the same "visible is the safe failure" reasoning
 * `getHiddenSurfaceKeys` uses, pointed the other way: silence is the safe failure here.
 */
export async function getAccountAlerts(
  userId: string,
  now: Date = new Date(),
  context?: AccountHealthContext
): Promise<AccountAlert[]> {
  try {
    const input = await loadAccountHealthInput(userId, now, context);
    if (!input) return [];

    const alerts = sortAccountAlerts(toAccountAlerts(evaluateAccountHealth(input, now)));

    // An operator who has hidden a surface has deliberately turned that remedy off. Drop
    // the whole alert rather than stripping its button: an alert the user cannot act on is
    // worse than silence. `resolveSurfaceVisibility` rather than `getHiddenSurfaceKeys`,
    // so an exempt admin still sees their own alerts — and it is already `cache()`d and
    // awaited once per request by the app shell, so this costs nothing.
    const { hidden } = await resolveSurfaceVisibility(userId);
    const visible = alerts.filter(
      (a) => a.surfaceKey === null || !hidden.has(a.surfaceKey)
    );

    return visible.slice(0, MAX_ACCOUNT_ALERTS);
  } catch {
    return [];
  }
}

export { hasErrorAlert };
