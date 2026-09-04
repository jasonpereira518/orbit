import { FlaskConical } from "lucide-react";
import { TestingConsole } from "@/components/testing/testing-console";
import { requireUserForSurface } from "@/lib/plan-guards";

/**
 * The testing console — reset your own data, and run the jobs that normally wait on cron.
 *
 * A beta surface, so the guard below is doing three jobs at once: signed in, on a testing
 * account, and the surface has not been killed from `/admin/product`. The layout resolves
 * the same thing for the route, and every action in `@/actions/testing` repeats it — nav
 * filtering is cosmetic and Server Functions are reachable by direct POST.
 */
export default async function TestingPage() {
  await requireUserForSurface("page.testing");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
            Testing
          </h1>
          <span className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent-foreground">
            Beta
          </span>
        </div>
        <p className="mt-1 text-muted-foreground">
          Tools for exercising Orbit against real data. Everything here acts on your own
          account only, and two of them are destructive.
        </p>
      </div>

      <div className="flex gap-3 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
        <FlaskConical className="mt-0.5 size-4 shrink-0" />
        <p>
          Your account is a testing account, which is also why nothing in Orbit is paywalled
          for you right now. That is separate from any real plan you hold — turning testing
          off restores whatever you were on before.
        </p>
      </div>

      <TestingConsole />
    </div>
  );
}
