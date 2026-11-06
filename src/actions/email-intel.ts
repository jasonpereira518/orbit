"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { gmailConnections, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { deleteEmailEventChunks } from "@/lib/email-intel/search-index";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { requireEntitlement } from "@/lib/entitlements";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { hasGmailReadScope } from "@/lib/google-scopes";

/**
 * The Email insights switch. Turning it on needs the recruiter plan and Gmail's read scope,
 * and starts a fresh backfill (cursor and schedule cleared). Turning it off stops the sweep
 * and leaves what it already recorded; deleting that is Gmail disconnect or an insights wipe.
 *
 * Answers rather than throws, like `setCalendarSync`: the switch shows the refusal verbatim.
 */
export async function setEmailIntel(enabled: boolean): Promise<ActionResult<void>> {
  return asActionResult(async () => {
    const userId = await requireUserId();
    if (await isDemoWorkspace(userId)) {
      throw new UserFacingError("Email insights aren’t available in the demo workspace");
    }
    const db = await getDb();
    if (enabled) {
      await requireEntitlement(userId, "recruiters");
      const conn = await db.query.gmailConnections.findFirst({
        where: eq(gmailConnections.userId, userId),
        columns: { scopes: true, status: true },
      });
      if (!conn || conn.status !== "active" || !hasGmailReadScope(conn.scopes)) {
        throw new UserFacingError("Allow Orbit to read your email first — connect Gmail and tick mail access");
      }
    }
    await db
      .insert(userSettings)
      .values({ userId, emailIntelEnabled: enabled ? 1 : 0 })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          emailIntelEnabled: enabled ? 1 : 0,
          // A fresh enable backfills from scratch and is due at once.
          ...(enabled ? { emailIntelCursorAt: null, emailIntelNextAt: null } : {}),
          updatedAt: new Date(),
        },
      });
    // Off means chat stops finding what the mail said, at once. The events stay on file (turning
    // it back on re-indexes them), as the copy says; only the search index is removed.
    if (!enabled) await deleteEmailEventChunks(userId);
    revalidatePath("/settings");
  });
}
