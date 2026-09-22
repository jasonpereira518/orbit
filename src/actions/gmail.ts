"use server";

import { and, desc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { gmailConnections, imports, userSettings } from "@/db/schema";
import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import { getAiConfig } from "@/lib/ai";
import { isAiAccessError } from "@/lib/ai-access";
import {
  GMAIL_SCAN_IMPORT_TYPE,
  runGmailRecruiterScanJob,
} from "@/lib/gmail-scan-processor";
import {
  hasCalendarScope,
  buildGmailAuthUrl,
  getGmailOAuthConfigSummary,
  hasContactsScope,
  hasGmailReadScope,
  hasSendScope,
} from "@/lib/gmail";
import { isGooglePurpose, type GooglePurpose } from "@/lib/google-scopes";
import { deriveConnectionHealth, type ConnectionHealth } from "@/lib/connection-status";
import { revokeGoogleGrant } from "@/lib/oauth-revoke";
import { purgeUserData } from "@/lib/user-data";
import { DISCONNECT_DELETE_CATEGORIES } from "@/lib/data-categories";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { safeReturnPath } from "@/lib/oauth-return";

const OAUTH_STATE_COOKIE = "orbit_gmail_oauth_state";

export type GmailConnectionStatus = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  lastSyncedAt: string | null;
  /**
   * False for connections made before the send scope shipped. Those users are connected
   * and can scan, but must reconnect before Orbit can send on their behalf.
   */
  canSend: boolean;
  /** Null when there is no connection row. See `deriveConnectionHealth`. */
  status: ConnectionHealth | null;
  /** The scheduler's last error, verbatim — never rendered as-is (`calendarPauseLine`). */
  syncError: string | null;
  /** ISO time of the next calendar sync, or null when none is scheduled. */
  nextSyncAt: string | null;
  /** The grant covers gmail.readonly: the recruiter scan and confirmation emails can run. */
  canRead: boolean;
  /** The grant covers contacts.readonly. */
  canImportContacts: boolean;
  /** Safe: configured redirect URI only (no secrets). */
  redirectUri: string | null;
};

export async function getGmailConnectionStatus(): Promise<GmailConnectionStatus> {
  const userId = await requireUserId();
  const summary = getGmailOAuthConfigSummary();
  if (!summary.configured) {
    return {
      configured: false,
      connected: false,
      emailAddress: null,
      lastSyncedAt: null,
      canSend: false,
      status: null,
      syncError: null,
      nextSyncAt: null,
      canRead: false,
      canImportContacts: false,
      redirectUri: summary.redirectUri,
    };
  }

  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });

  return {
    configured: true,
    connected: Boolean(conn && conn.status === "active"),
    emailAddress: conn?.emailAddress || null,
    lastSyncedAt: conn?.lastSyncedAt?.toISOString() || null,
    canSend: Boolean(conn && conn.status === "active" && hasSendScope(conn.scopes)),
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
    canRead: Boolean(conn && conn.status === "active" && hasGmailReadScope(conn.scopes)),
    canImportContacts: Boolean(conn && conn.status === "active" && hasContactsScope(conn.scopes)),
    redirectUri: summary.redirectUri,
  };
}

export async function startGmailOAuth(input: {
  purpose: GooglePurpose;
  returnTo?: string;
}): Promise<{ url: string }> {
  if (!isGooglePurpose(input.purpose)) throw new Error("Unknown Google connection purpose");
  const userId = await requireSyncUser();
  const summary = getGmailOAuthConfigSummary();
  if (!summary.configured) {
    const hint = summary.redirectUriError
      ? ` (${summary.redirectUriError})`
      : "";
    throw new Error(
      `Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.${hint}`
    );
  }

  // Safe diagnostic — redirect URI only, never secret/tokens
  console.info("[gmail-oauth] starting auth", {
    redirectUri: summary.redirectUri,
    hasClientId: summary.hasClientId,
  });

  // returnTo is a same-origin path only — never an absolute/external URL.
  const safeReturnTo = safeReturnPath(input.returnTo) ?? "";
  // The purpose rides in the state so the callback can check that Google granted the one
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

  return { url: buildGmailAuthUrl(state, input.purpose) };
}

export async function disconnectGmail(opts: { alsoDelete?: boolean } = {}) {
  const userId = await requireUserId();
  const db = await getDb();
  const grant = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { refreshTokenEncrypted: true, accessTokenEncrypted: true },
  });
  // Row first: the disconnect is done even if Google never answers.
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
  if (grant) await revokeGoogleGrant(grant);
  if (opts.alsoDelete === true) {
    await purgeUserData(userId, { only: DISCONNECT_DELETE_CATEGORIES.gmail });
  }
  revalidatePath("/recruiters");
}

export async function consumeGmailOAuthState(
  state: string | null
): Promise<{ userId: string; returnTo: string | null; purpose: GooglePurpose | null }> {
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
    purpose: isGooglePurpose(rawPurpose) ? rawPurpose : null,
  };
}


export type GmailScanStatus = {
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

function toScanStatus(row: typeof imports.$inferSelect): GmailScanStatus {
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
 * only polls.
 */
export async function startGmailRecruiterScan(): Promise<ActionResult<{ importId: string }>> {
  return asActionResult(async () => {
    const userId = await requireSyncUser();
    const db = await getDb();

    const conn = await db.query.gmailConnections.findFirst({
      where: eq(gmailConnections.userId, userId),
    });
    if (!conn || conn.status !== "active") {
      throw new UserFacingError("Connect Gmail first, then scan");
    }
    if (!hasGmailReadScope(conn.scopes)) {
      throw new UserFacingError("Allow Orbit to read your mail first — reconnect Gmail and tick mail access");
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
        eq(imports.importType, GMAIL_SCAN_IMPORT_TYPE),
        eq(imports.status, "processing")
      ),
    });
    if (running) return { importId: running.id };

    const [row] = await db
      .insert(imports)
      .values({
        userId,
        importType: GMAIL_SCAN_IMPORT_TYPE,
        fileName: conn.emailAddress,
        status: "processing",
        totalRows: null,
        rowsProcessed: 0,
        stats: { discoveryComplete: false, messagesScanned: 0 },
      })
      .returning();

    after(() => runGmailRecruiterScanJob(row.id).catch(() => {}));
    revalidatePath("/recruiters");
    return { importId: row.id };
  });
}

/** Read-only poll target for the scan panel. */
export async function getGmailScanStatus(
  importId?: string
): Promise<GmailScanStatus | null> {
  const userId = await requireUserId();
  const db = await getDb();

  const row = importId
    ? await db.query.imports.findFirst({
        where: and(eq(imports.id, importId), eq(imports.userId, userId)),
      })
    : await db.query.imports.findFirst({
        where: and(
          eq(imports.userId, userId),
          eq(imports.importType, GMAIL_SCAN_IMPORT_TYPE)
        ),
        orderBy: [desc(imports.createdAt)],
      });

  if (!row || row.importType !== GMAIL_SCAN_IMPORT_TYPE) return null;
  return toScanStatus(row);
}

export async function cancelGmailRecruiterScan(importId: string) {
  const userId = await requireSyncUser();
  const db = await getDb();
  // The runner re-reads status every iteration, so flipping the row is the cancel.
  await db
    .update(imports)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
  revalidatePath("/recruiters");
}


export type GmailSendIdentity = {
  connected: boolean;
  /** False when the connection predates the send scope — draft is fine, send is not. */
  canSend: boolean;
  /**
   * The address recruiters will actually see. Always the connected Google account:
   * Gmail sends as the account that authorized it and will not honour an arbitrary
   * `From`, so this is a fact to surface, never a preference to set.
   */
  sendingAs: string | null;
  displayName: string | null;
  /** The address this user signs into Orbit with, mirrored from Clerk. */
  loginEmail: string | null;
  /**
   * False when the two differ. Not an error — signing into Orbit with a work SSO
   * address while job-searching from a personal Gmail is legitimate and common — but
   * the compose UI must say so out loud before anything is sent.
   */
  matchesLogin: boolean;
};

export async function getGmailSendIdentity(): Promise<GmailSendIdentity> {
  const userId = await requireUserId();
  const db = await getDb();

  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });

  const profile = await getCurrentUserProfile().catch(() => null);
  let loginEmail = profile?.email?.trim().toLowerCase() || null;
  if (!loginEmail) {
    // Falls back to the column the Clerk webhook mirrors, so this still resolves on
    // background paths and whenever the Clerk lookup is unavailable.
    const settings = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { email: true },
    });
    loginEmail = settings?.email?.trim().toLowerCase() || null;
  }

  const connected = Boolean(conn && conn.status === "active");
  const sendingAs = connected ? conn!.emailAddress.trim().toLowerCase() : null;

  return {
    connected,
    canSend: connected && hasSendScope(conn!.scopes),
    sendingAs,
    displayName: profile?.name?.trim() || null,
    loginEmail,
    // Unknown login email must not read as a mismatch and raise a false alarm.
    matchesLogin: !sendingAs || !loginEmail || sendingAs === loginEmail,
  };
}
