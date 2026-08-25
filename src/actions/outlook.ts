"use server";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { outlookConnections } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import { buildMicrosoftAuthUrl, getOutlookOAuthConfigSummary } from "@/lib/outlook";

const OAUTH_STATE_COOKIE = "orbit_outlook_oauth_state";

export type OutlookConnectionStatus = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  lastSyncedAt: string | null;
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
