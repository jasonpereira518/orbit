"use server";

import { after } from "next/server";
import { requireUserId } from "@/lib/auth";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { claimConnectionNow } from "@/lib/provider-connections";
import { runClaimedConnectionNow } from "@/lib/sync-scheduler";
import { reportError } from "@/lib/report-error";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";

/**
 * The Google and Microsoft pages' Sync now. Claims the connection here — so a refusal is
 * answered at once ("already syncing", or it synced moments ago) — then runs the same pass the
 * cron would, after the response. The page re-reads until the last-synced time moves.
 */
export async function syncAccountNow(provider: "google" | "microsoft"): Promise<ActionResult<void>> {
  return asActionResult(async () => {
    if (provider !== "google" && provider !== "microsoft") throw new UserFacingError("Pick an account");
    const userId = await requireUserId();
    if (await isDemoWorkspace(userId)) return;
    const conn = await claimConnectionNow(provider, userId);
    if (!conn) throw new UserFacingError("It synced moments ago or is syncing now — try again in a minute");
    after(() =>
      runClaimedConnectionNow(conn).catch((err) =>
        reportError(err, { where: "action.sync-now", userId, level: "warning", extra: { provider } })
      )
    );
  });
}
