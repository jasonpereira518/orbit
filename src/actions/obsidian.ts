"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import {
  deleteConnectorConnection,
  getConnectorConnection,
  upsertConnectorConnection,
} from "@/lib/connectors/connections";
import { asActionResult, type ActionResult } from "@/lib/errors";

export async function getObsidianStatus() {
  const userId = await requireUserId();
  const conn = await getConnectorConnection(userId, "obsidian");
  if (!conn) {
    return { connected: false, localUrl: null, lastSyncedAt: null, syncError: null };
  }
  return {
    connected: conn.status === "active",
    localUrl: conn.accountRef,
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    syncError: conn.syncError,
  };
}

export async function connectObsidian(input: {
  apiKey: string;
  localUrl?: string;
}): Promise<ActionResult<{ connected: boolean }>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const apiKey = input.apiKey.trim();
    const localUrl = (input.localUrl?.trim() || "http://127.0.0.1:27123").replace(/\/+$/, "");

    await upsertConnectorConnection({
      userId,
      connectorId: "obsidian",
      authKind: "api_key",
      label: "Obsidian Vault",
      accountRef: localUrl,
      accessToken: apiKey,
      capabilities: ["importContacts"],
    });

    revalidatePath("/settings");
    return { connected: true };
  });
}

export async function disconnectObsidian(): Promise<void> {
  const userId = await requireUserId();
  await deleteConnectorConnection(userId, "obsidian");
  revalidatePath("/settings");
}
