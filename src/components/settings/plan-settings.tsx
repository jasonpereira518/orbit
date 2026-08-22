import Link from "next/link";
import { Check, Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { planCopy } from "@/lib/plan-copy";
import type { Entitlements, PlanSource } from "@/lib/entitlements";

const SOURCE_NOTE: Record<PlanSource, string | null> = {
  comp: "Granted to you directly — no billing attached.",
  lifetime: "One-time purchase. Yours permanently.",
  subscription: null,
  free: null,
};

export function PlanSettings({
  entitlements,
  usage,
}: {
  entitlements: Entitlements;
  usage: { used: number; limit: number | null; remaining: number | null };
}) {
  const copy = planCopy(entitlements.plan);
  const note = SOURCE_NOTE[entitlements.source];
  const isFree = entitlements.plan === "free";

  // Only meaningful on a capped plan; an over-cap user (a lapsed subscriber) shows a full
  // bar rather than a negative remainder, and keeps full access to everything they have.
  const atLimit = usage.limit !== null && usage.used >= usage.limit;
  const pct =
    usage.limit === null ? 0 : Math.min(100, (usage.used / usage.limit) * 100);

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-primary">Plan</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.tagline}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3 py-1 text-sm font-medium text-primary">
          {entitlements.plan !== "free" && <Sparkles className="size-3.5" />}
          {copy.name}
        </span>
      </div>

      {note && <p className="text-sm text-muted-foreground">{note}</p>}

      {usage.limit !== null ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Contacts</span>
            <span className={cn("tabular-nums", atLimit && "text-primary")}>
              {usage.used} / {usage.limit}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={usage.used}
            aria-valuemin={0}
            aria-valuemax={usage.limit}
            aria-label="Contacts used"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          {atLimit && (
            <p className="text-sm text-muted-foreground">
              You&apos;ve reached the limit, so new contacts can&apos;t be added.
              Everything already in your orbit stays exactly as it is.
            </p>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="size-4 text-primary" />
          Unlimited contacts — {usage.used} in your orbit.
        </p>
      )}

      {!entitlements.canUseHostedEnrichment && entitlements.plan !== "free" && (
        <p className="rounded-xl border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground">
          Contact enrichment runs on your own Apollo key. Add it in the Outreach
          section below. Email and SMS sending is included on your plan.
        </p>
      )}

      {isFree && (
        <div className="flex flex-wrap items-center gap-3">
          {/* Points at the transaction page, not back at /pricing — that round trip was a
              loop with no way to actually pay at either end. */}
          <Link
            href="/upgrade"
            className={cn(buttonVariants({ size: "sm" }))}
          >
            Upgrade
          </Link>
          <Link
            href="/pricing"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Compare plans
          </Link>
        </div>
      )}
    </section>
  );
}
