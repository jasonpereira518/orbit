"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import {
  getConnectorConnection,
  deleteConnectorConnection,
  upsertConnectorConnection,
} from "@/lib/connectors/connections";
import { discoverAddressBook, CalDavAuthError } from "@/lib/caldav/client";
import { asActionResult, type ActionResult } from "@/lib/errors";

export type AppleContactsStatus = {
  connected: boolean;
  emailAddress: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  syncStatus: string | null;
};

export async function getAppleContactsStatus(): Promise<AppleContactsStatus> {
  const userId = await requireUserId();
  const conn = await getConnectorConnection(userId, "apple_contacts");
  if (!conn) {
    return {
      connected: false,
      emailAddress: null,
      lastSyncedAt: null,
      syncError: null,
      syncStatus: null,
    };
  }
  return {
    connected: conn.status === "active",
    emailAddress: conn.accountRef,
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    syncError: conn.syncError,
    syncStatus: conn.syncStatus,
  };
}

export async function connectAppleContacts(input: {
  appleId: string;
  appPassword: string;
}): Promise<ActionResult<{ addressBookFound: boolean }>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const appleId = input.appleId.trim().toLowerCase();
    const password = input.appPassword.trim();

    try {
      const discovery = await discoverAddressBook({ username: appleId, password });
      await upsertConnectorConnection({
        userId,
        connectorId: "apple_contacts",
        authKind: "dav_password",
        label: "Apple Contacts",
        accountRef: appleId,
        accessToken: password,
        capabilities: ["syncPeople"],
        syncCursor: {
          addressBookUrl: discovery.addressBookUrl,
        },
      });
      revalidatePath("/settings");
      return { addressBookFound: true };
    } catch (err) {
      if (err instanceof CalDavAuthError) {
        throw new Error("Apple didn’t accept that — check the app-specific password and try again");
      }
      throw err;
    }
  });
}

export async function disconnectAppleContacts(): Promise<void> {
  const userId = await requireUserId();
  await deleteConnectorConnection(userId, "apple_contacts");
  revalidatePath("/settings");
}
