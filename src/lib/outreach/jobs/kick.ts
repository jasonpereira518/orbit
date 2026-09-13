import { after } from "next/server";
import { internalFetch } from "@/lib/internal-auth";

/**
 * Best-effort nudge after an action enqueues work. A lost kick costs latency, not work: the
 * scheduler's worker call and the next kick pick the jobs up. Imports `next/server`, so only
 * actions and routes may import this module — never a lib module a smoke script reaches.
 */
export function kickOutreachWorker(): void {
  try {
    after(async () => {
      if (process.env.NODE_ENV === "development") {
        // Locally there is no scheduler, and `getAppBaseUrl()` falls back to port 3000 — which
        // may be another worktree's server. Drain in-process instead.
        const { runWorkerPass } = await import("@/lib/outreach/jobs/worker");
        const { defaultJobHandlers } = await import("@/lib/outreach/jobs/handlers");
        await runWorkerPass({ handlers: defaultJobHandlers() }).catch(() => null);
        return;
      }
      await internalFetch("/api/outreach/worker", { method: "POST" }).catch(() => null);
    });
  } catch {
    // Outside a request scope (a script): nothing to do; the scheduler will run the jobs.
  }
}
