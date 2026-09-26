"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import {
  connectAppleAccount,
  disconnectAppleAccount,
  readAppleConnectionStatus,
  setAppleCalendarEnabledForUser,
  type AppleConnectionStatus,
} from "@/lib/apple";
import { asActionResult, type ActionResult } from "@/lib/errors";

export async function getAppleConnectionStatus(): Promise<AppleConnectionStatus> {
  const userId = await requireUserId();
  return readAppleConnectionStatus(userId);
}

/**
 * Connecting any calendar account — Google, Microsoft, Apple — is free (a controller
 * ruling; see `src/lib/apple.ts`'s header comment), so this calls `requireUserId()` and
 * never `requireSyncUser()`. The whole CalDAV discovery walk (`connectAppleAccount`) runs
 * before anything is written, so a wrong password comes back here as data — a thrown
 * `UserFacingError` would otherwise reach the browser as an opaque digest in production.
 */
export async function connectApple(input: {
  appleId: string;
  appPassword: string;
}): Promise<ActionResult<{ calendars: number }>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const result = await connectAppleAccount(userId, input);
    revalidatePath("/settings");
    return result;
  });
}

export async function setAppleCalendarEnabled(input: {
  sourceId: string;
  enabled: boolean;
}): Promise<ActionResult<null>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    await setAppleCalendarEnabledForUser(userId, input.sourceId, input.enabled);
    revalidatePath("/settings");
    return null;
  });
}

export async function disconnectApple(): Promise<void> {
  const userId = await requireUserId();
  await disconnectAppleAccount(userId);
  revalidatePath("/settings");
}
