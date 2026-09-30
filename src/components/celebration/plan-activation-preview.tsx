"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { tierTheme, type PaidPlan } from "@/lib/celebration/tier-theme";

const CelebrationStage = dynamic(
  () =>
    import("@/components/celebration/celebration-stage").then((module) => ({
      default: module.CelebrationStage,
    })),
  { ssr: false },
);

const PlanDowngradeStage = dynamic(
  () =>
    import("@/components/celebration/plan-downgrade-stage").then((module) => ({
      default: module.PlanDowngradeStage,
    })),
  { ssr: false },
);

const PREVIEWS: { plan: PaidPlan; label: string; description: string }[] = [
  {
    plan: "orbit",
    label: "Orbit Pro",
    description: "A blue orbit gathers and ignites.",
  },
  {
    plan: "max",
    label: "Orbit Max",
    description: "A gold flare breaks into expanding waves.",
  },
  {
    plan: "lifetime",
    label: "Orbit Lifetime",
    description: "A silver seal draws closed and holds.",
  },
];

export function PlanActivationPreview() {
  const [active, setActive] = useState<PaidPlan | null>(null);
  const [downgrade, setDowngrade] = useState<PaidPlan | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-12">
      <header className="space-y-2">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Plan activation preview
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Play each plan&apos;s activation or Free transition. Dismiss it to return to these controls.
        </p>
      </header>

      <section
        aria-label="Activation displays"
        className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
      >
        {PREVIEWS.map(({ plan, label, description }) => (
          <div
            key={plan}
            className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="mt-1 size-3 shrink-0 rounded-full"
                style={{ backgroundColor: tierTheme(plan).accent }}
              />
              <div>
                <h2 className="font-semibold text-foreground">{label}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => setActive(plan)}
            >
              Play {label}
            </Button>
          </div>
        ))}
      </section>

      <section aria-label="Paid to Free displays" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-[family-name:var(--font-display)] text-xl text-ink">
            Paid to Free
          </h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={reducedMotion}
              onChange={(event) => setReducedMotion(event.target.checked)}
              className="size-4 accent-foreground"
            />
            Preview reduced motion
          </label>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {PREVIEWS.map(({ plan, label }) => (
            <div
              key={plan}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden
                  className="mt-1 size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: tierTheme(plan).accent }}
                />
                <div>
                  <h3 className="font-semibold text-foreground">{label} → Free</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    The plan color and ring fade into the Free state.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => setDowngrade(plan)}
              >
                Play {label} → Free
              </Button>
            </div>
          ))}
        </div>
      </section>

      <p className="text-sm text-muted-foreground">
        Previewing does not change your plan, billing, or transition history.
      </p>

      {active &&
        createPortal(
          <CelebrationStage
            key={active}
            theme={tierTheme(active)}
            handoffToAppLogo={false}
            onDone={() => setActive(null)}
          />,
          document.body,
        )}
      {downgrade &&
        createPortal(
          <PlanDowngradeStage
            key={downgrade}
            fromPlan={downgrade}
            forceReducedMotion={reducedMotion}
            onDone={() => setDowngrade(null)}
          />,
          document.body,
        )}
    </div>
  );
}
