"use server";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { logRecruiter } from "@/actions/recruiters";
import {
  buildGmailAuthUrl,
  isGmailConfigured,
  scanGmailForRecruiters,
  type GmailRecruiterCandidate,
} from "@/lib/gmail";

const OAUTH_STATE_COOKIE = "orbit_gmail_oauth_state";

export type GmailConnectionStatus = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  lastSyncedAt: string | null;
};

export async function getGmailConnectionStatus(): Promise<GmailConnectionStatus> {
  const userId = await requireUserId();
  const configured = isGmailConfigured();
  if (!configured) {
    return {
      configured: false,
      connected: false,
      emailAddress: null,
      lastSyncedAt: null,
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
  };
}

export async function startGmailOAuth(): Promise<{ url: string }> {
  const userId = await requireUserId();
  if (!isGmailConfigured()) {
    throw new Error(
      "Gmail is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
    );
  }

  const state = `${userId}:${crypto.randomUUID()}`;
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

export async function scanGmailRecruiters(): Promise<GmailRecruiterCandidate[]> {
  const userId = await requireUserId();
  return scanGmailForRecruiters(userId);
}

export async function confirmGmailRecruiterImports(
  candidates: Array<{
    fullName: string;
    email: string;
    firm?: string | null;
    linkedinUrl?: string | null;
  }>
) {
  const userId = await requireUserId();
  void userId;
  let imported = 0;
  for (const c of candidates) {
    if (!c.fullName?.trim() || !c.email?.trim()) continue;
    await logRecruiter({
      fullName: c.fullName.trim(),
      email: c.email.trim(),
      firm: c.firm || undefined,
      linkedinUrl: c.linkedinUrl || undefined,
      status: "contacted",
      source: "gmail",
      notes: "Imported from Gmail",
    });
    imported += 1;
  }
  revalidatePath("/recruiters");
  return { imported };
}

export async function consumeGmailOAuthState(state: string | null) {
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!state || !expected || state !== expected) {
    throw new Error("Invalid OAuth state");
  }
  const userId = state.split(":")[0];
  if (!userId) throw new Error("Invalid OAuth state");
  return userId;
}
