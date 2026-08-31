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
import {
  GMAIL_SCAN_IMPORT_TYPE,
  runGmailRecruiterScanJob,
} from "@/lib/gmail-scan-processor";
import {
  buildGmailAuthUrl,
  getGmailOAuthConfigSummary,
  hasSendScope,
} from "@/lib/gmail";

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
    redirectUri: summary.redirectUri,
  };
}

export async function startGmailOAuth(
  returnTo?: string
): Promise<{ url: string }> {
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
  const safeReturnTo =
    returnTo && returnTo.startsWith("/") ? returnTo : "";
  const state = `${userId}:${crypto.randomUUID()}:${encodeURIComponent(safeReturnTo)}`;
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return { url: buildGmailAuthUrl(state) };
}

export async function disconnectGmail() {
  const userId = await requireUserId();
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
  revalidatePath("/recruiters");
}

export async function consumeGmailOAuthState(
  state: string | null
): Promise<{ userId: string; returnTo: string | null }> {
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!state || !expected || state !== expected) {
    throw new Error("Invalid OAuth state");
  }
  const [userId, , encodedReturnTo] = state.split(":");
  if (!userId) throw new Error("Invalid OAuth state");
  const returnTo = encodedReturnTo ? decodeURIComponent(encodedReturnTo) : "";
  return { userId, returnTo: returnTo.startsWith("/") ? returnTo : null };
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

  // What the scan cost and what it skipped. Surfaced rather than kept internal: the whole
  // design trades completeness for cost in specific places, and these are how a user (and a
  // future maintainer retuning the thresholds) can see where.
  /** Distinct conversations found, after collapsing multiple hits in one thread. */
  threadsDiscovered: number;
  /** Threads that scored between the reject and accept thresholds and were dropped. */
  triageDeferred: number;
  /** Stages read straight off ATS templates — no model call, no tokens. */
  atsRuleHits: number;
  /** Model calls actually issued. */
  llmCalls: number;
  /** Findings waiting for review, having written nothing yet. */
  findingsPending: number;
  opportunitiesFound: number;
  /** True when this run ignored the watermark and re-read the whole window. */
  isFullScan: boolean;
  /** Start of the window this run read, ISO. Null on jobs from before the window existed. */
  scanAfter: string | null;
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
    threadsDiscovered: stats.threadsDiscovered ?? 0,
    triageDeferred: stats.triageDeferred ?? 0,
    atsRuleHits: stats.atsRuleHits ?? 0,
    llmCalls: stats.llmCalls ?? 0,
    findingsPending: stats.findingsPending ?? 0,
    opportunitiesFound: stats.opportunitiesFound ?? 0,
    isFullScan: stats.scanIsFull === true,
    scanAfter: stats.scanAfter ?? null,
  };
}

/**
 * Queue a recruiter scan and return immediately.
 *
 * Incremental by default: the job resolves its own window from the user's watermark, so a
 * routine re-scan reads only what has arrived since the last completed run. `full` ignores
 * the watermark and re-reads the whole configured window — the escape hatch for when the
 * classifier itself has improved and old verdicts deserve another look.
 *
 * The work is owned by the server (rows in `import_job_rows`, self-continuation, cron
 * backstop), so it survives navigation, a closed tab, and a dead invocation. The client
 * only polls.
 */
export async function startGmailRecruiterScan(
  opts: { full?: boolean } = {}
): Promise<{ importId: string }> {
  const userId = await requireSyncUser();
  const db = await getDb();

  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });
  if (!conn || conn.status !== "active") {
    throw new Error("Connect Gmail before scanning.");
  }

  // Fail here rather than after the mailbox sweep: classification is the whole point of
  // the scan, and `getAiConfig` throws for a user with no key configured.
  try {
    await getAiConfig(userId);
  } catch {
    throw new Error(
      "Add an AI provider key in Settings before scanning — the scan uses it to identify recruiters and summarize your threads."
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
      // `scanIsFull` is read back by the runner when it resolves the window on its first
      // invocation; everything else about the window is decided there, not here.
      stats: {
        discoveryComplete: false,
        messagesScanned: 0,
        scanIsFull: opts.full === true,
      },
    })
    .returning();

  after(() => runGmailRecruiterScanJob(row.id).catch(() => {}));
  revalidatePath("/recruiters");
  return { importId: row.id };
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
