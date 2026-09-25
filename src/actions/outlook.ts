"use server";

import { and, desc, eq } from "drizzle-orm";
import { safeReturnPath } from "@/lib/safe-return-path";
import { cookies } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { purgeUserData } from "@/lib/user-data";
import { DISCONNECT_DELETE_CATEGORIES } from "@/lib/data-categories";
import { getDb } from "@/db";
import { outlookConnections, imports } from "@/db/schema";
import { deleteCalendarSourcesForProvider } from "@/lib/calendar-sources";
import { requireUserId } from "@/lib/auth";
import { deriveConnectionHealth, type ConnectionHealth } from "@/lib/connection-status";
import { requireConnectUser, requireSyncUser } from "@/lib/plan-guards";
import { getAiConfig } from "@/lib/ai";
import { isAiAccessError } from "@/lib/ai-access";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { demoWorkspaceEmail, isDemoWorkspace } from "@/lib/demo-workspace";
import { demoOutlookConnectionStatus } from "@/lib/demo-workspace-connections";
import { recordDemoRecruiterScan } from "@/lib/demo-workspace-actions";
import {
  OUTLOOK_SCAN_IMPORT_TYPE,
  runOutlookRecruiterScanJob,
} from "@/lib/outlook-scan-processor";
import {
  buildMicrosoftAuthUrl,
  getOutlookOAuthConfigSummary,
  hasCalendarScope,
  hasContactsScope,
  hasMailScope,
} from "@/lib/outlook";
import { isMicrosoftPurpose, type MicrosoftPurpose } from "@/lib/microsoft-scopes";

const OAUTH_STATE_COOKIE = "orbit_outlook_oauth_state";

export type OutlookConnectionStatus = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  lastSyncedAt: string | null;
  /** False for a connection that came in through calendar or mail alone — "Import contacts" must ask first. */
  hasContactsScope: boolean;
  /**
   * False until the person turns calendar sync on. Each Outlook feature asks for its own
   * scope (`microsoft-scopes.ts`), so a connected account can lack any of the three.
   */
  hasCalendarScope: boolean;
  /** False until the person allows mail access for the recruiter scan. */
  hasMailScope: boolean;
  /** Null when there is no connection row. See `deriveConnectionHealth`. */
  status: ConnectionHealth | null;
  /** The scheduler's last error, verbatim — never rendered as-is (`calendarPauseLine`). */
  syncError: string | null;
  /** ISO time of the next calendar sync, or null when none is scheduled. */
  nextSyncAt: string | null;
  /** Safe: configured redirect URI only (no secrets). */
  redirectUri: string | null;
};

export async function getOutlookConnectionStatus(): Promise<OutlookConnectionStatus> {
  const userId = await requireUserId();
  const demoEmail = await demoWorkspaceEmail(userId);
  if (demoEmail) return demoOutlookConnectionStatus(demoEmail);
  const summary = getOutlookOAuthConfigSummary();
  if (!summary.configured) {
    return {
      configured: false,
      connected: false,
      emailAddress: null,
      lastSyncedAt: null,
      hasContactsScope: false,
      hasCalendarScope: false,
      hasMailScope: false,
      status: null,
      syncError: null,
      nextSyncAt: null,
      redirectUri: summary.redirectUri,
    };
  }

  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });

  return {
    configured: true,
    connected: Boolean(conn && conn.status === "active"),
    emailAddress: conn?.emailAddress || null,
    lastSyncedAt: conn?.lastSyncedAt?.toISOString() || null,
    hasContactsScope: Boolean(conn && conn.status === "active" && hasContactsScope(conn.scopes)),
    hasCalendarScope: Boolean(conn && conn.status === "active" && hasCalendarScope(conn.scopes)),
    hasMailScope: Boolean(conn && conn.status === "active" && hasMailScope(conn.scopes)),
    status: conn
      ? deriveConnectionHealth({
          status: conn.status,
          nextSyncAt: conn.nextSyncAt,
          syncError: conn.syncError,
          calendarScopeGranted: hasCalendarScope(conn.scopes),
        })
      : null,
    syncError: conn?.syncError ?? null,
    nextSyncAt: conn?.nextSyncAt?.toISOString() ?? null,
    redirectUri: summary.redirectUri,
  };
}

export async function startOutlookOAuth(input: {
  purpose: MicrosoftPurpose;
  returnTo?: string;
}): Promise<{ url: string }> {
  if (!isMicrosoftPurpose(input.purpose)) throw new Error("Unknown Microsoft connection purpose");
  const userId = await requireConnectUser(input.purpose);
  const summary = getOutlookOAuthConfigSummary();
  if (!summary.configured) {
    const hint = summary.redirectUriError ? ` (${summary.redirectUriError})` : "";
    throw new Error(
      `Outlook is not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI.${hint}`
    );
  }

  // returnTo is a same-origin path only — never an absolute/external URL.
  const safeReturnTo = safeReturnPath(input.returnTo) ?? "";
  // The purpose rides in the state so the callback can check that Microsoft granted the one
  // scope this entry point asked for. encodeURIComponent keeps ':' out of returnTo.
  const state = `${userId}:${crypto.randomUUID()}:${encodeURIComponent(safeReturnTo)}:${input.purpose}`;
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  // What the person already enabled rides along, so the newest grant covers all of it (see
  // `microsoftScopesFor`). Read for the current user only, and only ever passed to their own
  // authorization request.
  const db = await getDb();
  const existing = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { scopes: true },
  });

  return { url: buildMicrosoftAuthUrl(state, input.purpose, existing?.scopes) };
}

/**
 * Deleting the row is all Orbit can do: Microsoft has no endpoint that revokes one app's
 * delegated token (`revokeSignInSessions` would sign the user out of every app). The
 * disconnect dialog links the user to their Microsoft account to remove the grant there.
 */
export async function disconnectOutlook(opts: { alsoDelete?: boolean } = {}) {
  const userId = await requireUserId();
  // Nothing is stored to disconnect, and `alsoDelete` would purge the seeded workspace.
  if (await isDemoWorkspace(userId)) return;
  const db = await getDb();
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
  // Explicit, not a cascade: calendar_sources has no FK to any connection table (they are
  // deliberately separate — see provider-connections.ts), so a reconnect's fresh connection
  // id would otherwise never dedupe against the orphaned row and seedCalendarSources would
  // double the calendar.
  await deleteCalendarSourcesForProvider(userId, "microsoft");
  const extra = DISCONNECT_DELETE_CATEGORIES.outlook;
  if (opts.alsoDelete === true && extra.length > 0) {
    await purgeUserData(userId, { only: extra });
  }
  revalidatePath("/settings");
  revalidatePath("/recruiters");
}

export async function consumeOutlookOAuthState(
  state: string | null
): Promise<{ userId: string; returnTo: string | null; purpose: MicrosoftPurpose | null }> {
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!state || !expected || state !== expected) {
    throw new Error("Invalid OAuth state");
  }
  const [userId, , encodedReturnTo, rawPurpose] = state.split(":");
  if (!userId) throw new Error("Invalid OAuth state");
  const returnTo = encodedReturnTo ? decodeURIComponent(encodedReturnTo) : "";
  return {
    userId,
    returnTo: safeReturnPath(returnTo),
    purpose: isMicrosoftPurpose(rawPurpose) ? rawPurpose : null,
  };
}

export type OutlookScanStatus = {
  importId: string;
  status: string;
  /** Null until discovery finishes — the mailbox size is unknown before then. */
  totalSenders: number | null;
  processed: number;
  recruitersFound: number;
  messagesScanned: number;
  discoveryComplete: boolean;
  errorMessage: string | null;
  updatedAt: string;
};

function toScanStatus(row: typeof imports.$inferSelect): OutlookScanStatus {
  const stats = row.stats || {};
  return {
    importId: row.id,
    status: row.status,
    totalSenders: row.totalRows ?? null,
    processed: row.rowsProcessed ?? 0,
    recruitersFound: stats.recruitersFound ?? 0,
    messagesScanned: stats.messagesScanned ?? 0,
    discoveryComplete: Boolean(stats.discoveryComplete),
    errorMessage: row.errorMessage,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Queue a whole-mailbox recruiter scan and return immediately.
 *
 * The work is owned by the server (rows in `import_job_rows`, self-continuation, cron
 * backstop), so it survives navigation, a closed tab, and a dead invocation. The client
 * only polls. Mirrors `startGmailRecruiterScan`, including returning the messages written
 * for a person as data — a thrown message reaches the browser as a digest in production.
 */
export async function startOutlookRecruiterScan(): Promise<ActionResult<{ importId: string }>> {
  return asActionResult(async () => {
    const userId = await requireSyncUser();
    const demoEmail = await demoWorkspaceEmail(userId);
    if (demoEmail) {
      return { importId: await recordDemoRecruiterScan(userId, OUTLOOK_SCAN_IMPORT_TYPE, demoEmail) };
    }
    const db = await getDb();

    const conn = await db.query.outlookConnections.findFirst({
      where: eq(outlookConnections.userId, userId),
    });
    if (!conn || conn.status !== "active") {
      throw new UserFacingError("Connect Outlook first, then scan");
    }
    if (!hasMailScope(conn.scopes)) {
      throw new UserFacingError("Allow Orbit to read your mail first — reconnect Outlook and accept mail access");
    }

    // Fail here rather than after the mailbox sweep: classification is the whole point of
    // the scan, and `getAiConfig` throws when the AI gate would refuse this account. Asked
    // as the scan itself will ask ("recruiter.scan"), so a Lifetime account whose
    // background share of the managed allowance is spent is told so before it starts.
    try {
      await getAiConfig(userId, "recruiter.scan");
    } catch (err) {
      if (isAiAccessError(err) && err.reason !== "key_required") {
        throw new UserFacingError(err.message);
      }
      throw new UserFacingError(
        "Add an AI API key in Settings before scanning — the scan uses it to identify recruiters and summarize your threads"
      );
    }

    const running = await db.query.imports.findFirst({
      where: and(
        eq(imports.userId, userId),
        eq(imports.importType, OUTLOOK_SCAN_IMPORT_TYPE),
        eq(imports.status, "processing")
      ),
    });
    if (running) return { importId: running.id };

    const [row] = await db
      .insert(imports)
      .values({
        userId,
        importType: OUTLOOK_SCAN_IMPORT_TYPE,
        fileName: conn.emailAddress,
        status: "processing",
        totalRows: null,
        rowsProcessed: 0,
        stats: { discoveryComplete: false, messagesScanned: 0 },
      })
      .returning();

    after(() => runOutlookRecruiterScanJob(row.id).catch(() => {}));
    revalidatePath("/recruiters");
    return { importId: row.id };
  });
}

/** Read-only poll target for the scan panel. */
export async function getOutlookScanStatus(
  importId?: string
): Promise<OutlookScanStatus | null> {
  const userId = await requireUserId();
  const db = await getDb();

  const row = importId
    ? await db.query.imports.findFirst({
        where: and(eq(imports.id, importId), eq(imports.userId, userId)),
      })
    : await db.query.imports.findFirst({
        where: and(
          eq(imports.userId, userId),
          eq(imports.importType, OUTLOOK_SCAN_IMPORT_TYPE)
        ),
        orderBy: [desc(imports.createdAt)],
      });

  if (!row || row.importType !== OUTLOOK_SCAN_IMPORT_TYPE) return null;
  return toScanStatus(row);
}

export async function cancelOutlookRecruiterScan(importId: string) {
  const userId = await requireSyncUser();
  const db = await getDb();
  // The runner re-reads status every iteration, so flipping the row is the cancel.
  await db
    .update(imports)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
  revalidatePath("/recruiters");
}
