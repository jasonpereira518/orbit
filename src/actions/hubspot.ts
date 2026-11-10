"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/connectors/oauth";
import {
  deleteConnectorConnection,
  getConnectorConnection,
} from "@/lib/connectors/connections";

const HUBSPOT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.contacts.read",
];

export async function getHubSpotStatus() {
  const userId = await requireUserId();
  const conn = await getConnectorConnection(userId, "hubspot");
  if (!conn) {
    return { connected: false, portalRef: null, lastSyncedAt: null, syncError: null };
  }
  return {
    connected: conn.status === "active",
    portalRef: conn.accountRef,
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    syncError: conn.syncError,
  };
}

export async function startHubSpotConnect(returnTo: string = "/settings") {
  const userId = await requireUserId();
  const h = await headers();
  const origin = h.get("x-forwarded-proto")
    ? `${h.get("x-forwarded-proto")}://${h.get("host")}`
    : "http://localhost:3000";
  const redirectUri = process.env.APP_BASE_URL
    ? new URL("/api/hubspot/callback", process.env.APP_BASE_URL).href
    : `${origin}/api/hubspot/callback`;

  return buildAuthorizeUrl("hubspot", {
    userId,
    redirectUri,
    scopes: HUBSPOT_SCOPES,
    returnTo,
  });
}

export async function disconnectHubSpot(): Promise<void> {
  const userId = await requireUserId();
  await deleteConnectorConnection(userId, "hubspot");
  revalidatePath("/settings");
}
