"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/connectors/oauth";
import {
  deleteConnectorConnection,
  getConnectorConnection,
} from "@/lib/connectors/connections";

const SLACK_SCOPES = ["users:read", "users:read.email"];

export async function getSlackStatus() {
  const userId = await requireUserId();
  const conn = await getConnectorConnection(userId, "slack");
  if (!conn) {
    return { connected: false, teamName: null, lastSyncedAt: null, syncError: null };
  }
  return {
    connected: conn.status === "active",
    teamName: conn.accountRef,
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    syncError: conn.syncError,
  };
}

export async function startSlackConnect(returnTo: string = "/settings") {
  const userId = await requireUserId();
  const h = await headers();
  const origin = h.get("x-forwarded-proto")
    ? `${h.get("x-forwarded-proto")}://${h.get("host")}`
    : "http://localhost:3000";
  const redirectUri = process.env.APP_BASE_URL
    ? new URL("/api/slack/callback", process.env.APP_BASE_URL).href
    : `${origin}/api/slack/callback`;

  return buildAuthorizeUrl("slack", {
    userId,
    redirectUri,
    scopes: SLACK_SCOPES,
    returnTo,
  });
}

export async function disconnectSlack(): Promise<void> {
  const userId = await requireUserId();
  await deleteConnectorConnection(userId, "slack");
  revalidatePath("/settings");
}
