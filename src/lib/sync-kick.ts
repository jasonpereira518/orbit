import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export type SyncKickFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask the scheduler for a pass NOW rather than at the next 15-minute tick.
 *
 * Connecting Google or Outlook already arms the connection (`next_sync_at = now`), so it is
 * due the instant the OAuth callback finishes — it just waits for the next GitHub Actions run
 * to notice, and GitHub schedules lag by 5-30 minutes. For someone connecting during
 * onboarding that is a first look at an empty app. Kicking the same route the cron calls
 * closes the gap without a second code path: `runSyncPass` claims every due connection under
 * its own budget, and its own continuation kick handles a backlog.
 *
 * Best-effort, like the continuation kick beside it: if the kick is lost the next scheduled
 * run picks the connection up anyway, because it is still due. Callers put it in `after()`
 * so the redirect is not held up; the work itself runs in the route's own invocation, which
 * is why `after()` buying no extra time does not matter here.
 *
 * Resolves `true` when the scheduler was reached. A timeout counts: `/api/sync/run` runs its
 * pass inline, so a 10-second `internalFetch` timeout means it was busy working, not down.
 * Never rejects.
 */
export async function kickSyncPass(fetcher: SyncKickFetch = internalFetch): Promise<boolean> {
  try {
    const res = await fetcher("/api/sync/run", { method: "POST" });
    return res.ok;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return true;
    reportError(err, { where: "job.sync.kick", level: "warning" });
    return false;
  }
}
