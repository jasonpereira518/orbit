import Link from "next/link";
import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WarpLink } from "@/components/warp/warp-link";
import {
  PURCHASABLE_PLANS,
  PLAN_RANK,
  type Plan,
  type PurchasablePlan,
} from "@/lib/plans/plan-config";
import { getSurface } from "@/lib/surfaces";
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
  plans: only,
  note,
}: {
  title: string;
  description: string;
  highlights: string[];
  /** The cheapest plan that includes this feature (`unlockPlanFor`). */
  unlockPlan?: PurchasablePlan;
  /** The exact plans on sale that include it, when they are not simply `unlockPlan` and up. */
  plans?: readonly PurchasablePlan[];
  note?: string;
}) {
  const plans =
    only ?? PURCHASABLE_PLANS.filter((plan) => PLAN_RANK[plan] >= PLAN_RANK[unlockPlan]);
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

      {highlights.length > 0 && <ul className="mx-auto grid max-w-sm gap-2 text-left">
        {highlights.map((item) => (
          <li
            key={item}
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
          >
            {item}
          </li>
        ))}
      </ul>}

      <UnlocksWith plans={plans} className="justify-center" />

      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {plans.length > 0 && <WarpLink
          href="/pricing"
          className={cn(
            buttonVariants({ size: "sm" }),
            "border-tier-border bg-tier-surface text-tier-accent hover:bg-tier-accent/15"
          )}
        >
          See plans
        </WarpLink>}
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

/**
 * "Unlocks with [Pro] [Max]": the plans on sale that include a feature — `plan` and up, or
 * exactly `plans` when an operator limited a page to some tiers. Shared by the paywall, the
 * tier lock and the coming-soon screen so they can't disagree.
 */
export function UnlocksWith({
  plan = "orbit",
  plans: only,
  className,
}: {
  plan?: PurchasablePlan;
  plans?: readonly PurchasablePlan[];
  className?: string;
}) {
  const plans = only ?? PURCHASABLE_PLANS.filter((p) => PLAN_RANK[p] >= PLAN_RANK[plan]);
  if (!plans.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-sm text-muted-foreground", className)}>
      <span>Unlocks with</span>
      {plans.map((planId) => (
        <PlanBadge key={planId} plan={planId} />
      ))}
    </div>
  );
}

/**
 * A page an operator limited to some tiers on /admin/product (`setSurfaceTiers`). `plans`
 * are the tiers that may open it; only the ones on sale are offered, so a Lifetime-only
 * page says so in a note instead of pointing at a pricing page that cannot sell it.
 */
export function TierLocked({ surfaceKey, plans }: { surfaceKey: string; plans: readonly Plan[] }) {
  const surface = getSurface(surfaceKey);
  const onSale = PURCHASABLE_PLANS.filter((p) => plans.includes(p));
  const cheapest = onSale[0] ?? "max";
  return (
    <LockedFeature
      title={surface?.label ?? "This page"}
      description={surface?.description ?? "This page isn't included in your plan."}
      highlights={[]}
      unlockPlan={cheapest}
      plans={onSale}
      note={onSale.length === 0 ? "Available on Orbit Lifetime." : undefined}
    />
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
