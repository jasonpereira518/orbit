import Link from "next/link";
import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WarpLink } from "@/components/warp/warp-link";
import { PURCHASABLE_PLANS, PLAN_RANK, type PurchasablePlan } from "@/lib/plans/plan-config";
import { PlanBadge } from "@/components/plan-badge";

/**
 * Page-level state for a feature the current plan does not include.
 *
 * Shows what the feature does rather than hiding it, so the paywall reads as an
 * explanation instead of a dead end. This is presentation only — the real boundary is
 * `requireEntitlement` inside the server actions, which holds even against direct POSTs.
 *
 * Wears the color of the plan that unlocks it (Pro blue, Max gold) and lists the plans on
 * sale that include it. Lifetime is never offered: it is not sold.
 */
export function LockedFeature({
  title,
  description,
  highlights,
  unlockPlan = "orbit",
  note,
}: {
  title: string;
  description: string;
  highlights: string[];
  /** The cheapest plan that includes this feature (`unlockPlanFor`). */
  unlockPlan?: PurchasablePlan;
  note?: string;
}) {
  const plans = PURCHASABLE_PLANS.filter((plan) => PLAN_RANK[plan] >= PLAN_RANK[unlockPlan]);
  return (
    <div
      data-plan={unlockPlan}
      className="mx-auto max-w-xl space-y-6 rounded-2xl border border-tier-border bg-card p-8 text-center"
    >
      <div className="space-y-3">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full border border-tier-border bg-tier-surface">
          <Lock className="size-5 text-tier-accent" />
        </span>
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-ink">
          {title}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>

      <ul className="mx-auto grid max-w-sm gap-2 text-left">
        {highlights.map((item) => (
          <li
            key={item}
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
          >
            {item}
          </li>
        ))}
      </ul>

      {plans.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>Unlocks with</span>
          {plans.map((planId) => (
            <PlanBadge key={planId} plan={planId} />
          ))}
        </div>
      )}

      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <WarpLink
          href="/pricing"
          className={cn(
            buttonVariants({ size: "sm" }),
            "border-tier-border bg-tier-surface text-tier-accent hover:bg-tier-accent/15"
          )}
        >
          See plans
        </WarpLink>
        <Link
          href="/settings#settings-plan"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          Your plan
        </Link>
      </div>
    </div>
  );
}

/*
 * One lock per gated feature, rendered by EVERY page of that feature. Only the list pages
 * used to check, so a free user who followed a link or an old bookmark to a campaign, the
 * new-campaign wizard, or a recruiter's page got the full working UI, and every button on
 * it then failed with a paywall error. The reads behind those pages are deliberately
 * ungated (they return only the user's own rows); the pages are where the lock belongs.
 */

export function OutreachLocked() {
  return (
    <LockedFeature
      title="Outreach"
      description="Find the right people, draft messages that sound like you, and track what actually gets replies — without leaving Orbit."
      highlights={[
        "Search prospects by role, company, and seniority",
        "Personalized email and SMS drafts from your own notes",
        "Reply tracking and per-campaign quality scores",
        "Sequenced follow-ups that stop when someone replies",
      ]}
      note="Sending email and SMS runs on Orbit's credits."
    />
  );
}

export function RecruitersLocked() {
  return (
    <LockedFeature
      title="Recruiter tracking"
      description="A crowdsourced directory of recruiters, plus a record of every conversation you've had with each of them."
      highlights={[
        "Search recruiters by company and specialism",
        "Log interactions and unlock contact details",
        "Pull recruiter threads straight out of Gmail",
        "See who has gone quiet and who is worth a nudge",
      ]}
    />
  );
}
