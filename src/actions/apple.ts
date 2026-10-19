"use server";

import { revalidatePath } from "next/cache";
import {
  connectAppleAccount,
  disconnectAppleAccount,
  readAppleConnectionStatus,
  setAppleCalendarEnabledForUser,
  type AppleConnectionStatus,
} from "@/lib/apple";
import { asActionResult, type ActionResult } from "@/lib/errors";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";

export const getAppleConnectionStatus = defineAction(
  {},
  async (userId): Promise<AppleConnectionStatus> => {
    return readAppleConnectionStatus(userId);
  }
);

/**
 * Connecting any calendar account — Google, Microsoft, Apple — is free (a controller
 * ruling; see `src/lib/apple.ts`'s header comment), so this calls `requireUserId()` and
 * never `requireSyncUser()`. The whole CalDAV discovery walk (`connectAppleAccount`) runs
 * before anything is written, so a wrong password comes back here as data — a thrown
 * `UserFacingError` would otherwise reach the browser as an opaque digest in production.
 */
export const connectApple = defineAction(
  { schema: z.tuple([z.looseObject({ appleId: z.string(), appPassword: z.string() })]), invalid: failResult },
  async (userId, input: {
    appleId: string;
    appPassword: string;
  }): Promise<ActionResult<{ calendars: number }>> => {
    return asActionResult(async () => {
      const result = await connectAppleAccount(userId, input);
      revalidatePath("/settings");
      return result;
    });
  }
);

export const setAppleCalendarEnabled = defineAction(
  { schema: z.tuple([z.looseObject({ sourceId: z.string(), enabled: z.boolean() })]), invalid: failResult },
  async (userId, input: {
    sourceId: string;
    enabled: boolean;
  }): Promise<ActionResult<null>> => {
    return asActionResult(async () => {
      await setAppleCalendarEnabledForUser(userId, input.sourceId, input.enabled);
      revalidatePath("/settings");
      return null;
    });
  }
);

export const disconnectApple = defineAction(
  {},
  async (userId): Promise<void> => {
    await disconnectAppleAccount(userId);
    revalidatePath("/settings");
  }
);
