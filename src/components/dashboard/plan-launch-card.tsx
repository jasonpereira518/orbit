import { ArrowUpRight } from "lucide-react";
import { PlanBadge } from "@/components/plan-badge";
import { buttonVariants } from "@/components/ui/button";
import { WarpLink } from "@/components/warp/warp-link";
import { CARD_HOVER, PRESS } from "@/lib/interaction";
import { planCopy } from "@/lib/plan-copy";
import { FREE_CONTACT_LIMIT, PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";
import { cn } from "@/lib/utils";

/**
 * The plan card at the foot of the dashboard: one card, one link to /pricing.
 *
 * Free gets the offer ("your first N contacts are on us", Compare plans); a paid plan gets
 * the same card restated as a certificate — no pitch, no button that asks for money, just
 * the tier's own colour through the `data-plan` scope (`text-tier-accent`,
 * `hover:border-tier-accent`), the same tokens `PlanBadge` and the settings page use.
 *
 * It used to be painted in /pricing's night-sky colours with a canvas starfield and glow
 * shadows; the lift-off (`WarpLink`) is kept, the sky is not.
 */
export function PlanLaunchCard({ plan }: { plan: Plan }) {
  const paid = plan !== "free";
  const name = PLAN_LABELS[plan];
  return (
    <WarpLink
      href="/pricing"
      data-plan={plan}
      className={cn(
        "group block rounded-xl border border-border-subtle bg-card p-5 md:p-6",
        CARD_HOVER,
        PRESS,
        paid && "hover:border-tier-accent/60"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-0 max-w-md space-y-2">
          <PlanBadge plan={plan} />
          <h2 className="font-heading text-2xl leading-tight text-ink">
            {paid ? (
              <>
                You’re on <span className="text-tier-accent">{name}</span>.
              </>
            ) : (
              <>Your first {FREE_CONTACT_LIMIT} contacts are on us.</>
            )}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {paid
              ? planCopy(plan).tagline
              : "Past that, Orbit Pro keeps every contact, follow-up, and warm intro in one place — with AI included."}
          </p>
        </div>

        {/* A span, not a button: the whole card is the link. */}
        <span
          className={cn(
            buttonVariants({ variant: paid ? "outline" : "default" }),
            "shrink-0 transition-transform duration-fast ease-house group-hover:-translate-y-0.5"
          )}
        >
          {paid ? "See all plans" : "Compare plans"}
          <ArrowUpRight
            className="size-4 transition-transform duration-fast ease-house group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </WarpLink>
  );
}
