"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/connectors/oauth";
import {
  deleteConnectorConnection,
  getConnectorConnection,
} from "@/lib/connectors/connections";

const CALENDLY_SCOPES: string[] = [];

export async function getCalendlyStatus() {
  const userId = await requireUserId();
  const conn = await getConnectorConnection(userId, "calendly");
  if (!conn) {
    return { connected: false, accountEmail: null, lastSyncedAt: null, syncError: null };
  }
  return {
    connected: conn.status === "active",
    accountEmail: conn.accountRef,
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    syncError: conn.syncError,
  };
}

export async function startCalendlyConnect(returnTo: string = "/settings") {
  const userId = await requireUserId();
  const h = await headers();
  const origin = h.get("x-forwarded-proto")
    ? `${h.get("x-forwarded-proto")}://${h.get("host")}`
    : "http://localhost:3000";
  const redirectUri = process.env.APP_BASE_URL
    ? new URL("/api/calendly/callback", process.env.APP_BASE_URL).href
    : `${origin}/api/calendly/callback`;

  return buildAuthorizeUrl("calendly", {
    userId,
    redirectUri,
    scopes: CALENDLY_SCOPES,
    returnTo,
  });
}

export async function disconnectCalendly(): Promise<void> {
  const userId = await requireUserId();
  await deleteConnectorConnection(userId, "calendly");
  revalidatePath("/settings");
}
