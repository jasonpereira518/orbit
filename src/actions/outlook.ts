"use server";

import { and, desc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { outlookConnections, imports } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import { getAiConfig } from "@/lib/ai";
import {
  OUTLOOK_SCAN_IMPORT_TYPE,
  runOutlookRecruiterScanJob,
} from "@/lib/outlook-scan-processor";
import {
  buildMicrosoftAuthUrl,
  getOutlookOAuthConfigSummary,
  hasCalendarScope,
  hasMailScope,
} from "@/lib/outlook";

const OAUTH_STATE_COOKIE = "orbit_outlook_oauth_state";

export type OutlookConnectionStatus = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  lastSyncedAt: string | null;
  /**
   * False for connections made before the calendar scope shipped. Those users are
   * connected and can still sync contacts, but calendar sync is skipped until they
   * reconnect.
   */
  hasCalendarScope: boolean;
  /** False for connections made before the mail scope shipped — must reconnect to scan. */
  hasMailScope: boolean;
  /** Safe: configured redirect URI only (no secrets). */
  redirectUri: string | null;
};

export async function getOutlookConnectionStatus(): Promise<OutlookConnectionStatus> {
  const userId = await requireUserId();
  const summary = getOutlookOAuthConfigSummary();
  if (!summary.configured) {
    return {
      configured: false,
      connected: false,
      emailAddress: null,
      lastSyncedAt: null,
      hasCalendarScope: false,
      hasMailScope: false,
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
    hasCalendarScope: Boolean(conn && conn.status === "active" && hasCalendarScope(conn.scopes)),
    hasMailScope: Boolean(conn && conn.status === "active" && hasMailScope(conn.scopes)),
    redirectUri: summary.redirectUri,
  };
}

export async function startOutlookOAuth(returnTo?: string): Promise<{ url: string }> {
  const userId = await requireSyncUser();
  const summary = getOutlookOAuthConfigSummary();
  if (!summary.configured) {
    const hint = summary.redirectUriError ? ` (${summary.redirectUriError})` : "";
    throw new Error(
      `Outlook is not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI.${hint}`
    );
  }

  const safeReturnTo = returnTo && returnTo.startsWith("/") ? returnTo : "";
  const state = `${userId}:${crypto.randomUUID()}:${encodeURIComponent(safeReturnTo)}`;
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return { url: buildMicrosoftAuthUrl(state) };
}

export async function disconnectOutlook() {
  const userId = await requireUserId();
  const db = await getDb();
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
  revalidatePath("/recruiters");
}

export async function consumeOutlookOAuthState(
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
 * only polls. Mirrors `startGmailRecruiterScan` exactly.
 */
export async function startOutlookRecruiterScan(): Promise<{ importId: string }> {
  const userId = await requireSyncUser();
  const db = await getDb();

  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });
  if (!conn || conn.status !== "active") {
    throw new Error("Connect Outlook before scanning.");
  }
  if (!hasMailScope(conn.scopes)) {
    throw new Error("Reconnect Outlook to grant mail access before scanning.");
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
