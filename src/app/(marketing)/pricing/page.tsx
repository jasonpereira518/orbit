import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { PLAN_COPY } from "@/lib/plan-copy";
import { LIFETIME_SEAT_LIMIT } from "@/lib/entitlements";
import { countLifetimePurchases } from "@/lib/user-settings";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing — Orbit",
  description:
    "Orbit is free for up to 100 contacts. $5/month for unlimited, or $19 once for early adopters.",
};

export default async function PricingPage() {
  const sold = await countLifetimePurchases().catch(() => 0);
  const remainingSeats = Math.max(0, LIFETIME_SEAT_LIMIT - sold);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5 md:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
        >
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-primary">
            Orbit
          </span>
        </Link>
        <Link
          href="/sign-in"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-20 md:px-8">
        <header className="space-y-3 text-center">
          <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary sm:text-5xl">
            Pricing
          </h1>
          <p className="mx-auto max-w-2xl text-base leading-relaxed text-muted-foreground">
            Orbit runs on your own AI key on every plan, so you are never paying
            us a markup on tokens. Paid plans cover the parts that cost real
            money to run.
          </p>
        </header>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {PLAN_COPY.map((plan) => {
            const featured = plan.id === "orbit";
            const isLifetime = plan.id === "lifetime";
            const soldOut = isLifetime && remainingSeats === 0;

            return (
              <section
                key={plan.id}
                className={cn(
                  "flex flex-col rounded-2xl border p-6",
                  featured
                    ? "border-primary/60 bg-card shadow-sm"
                    : "border-border/70 bg-card"
                )}
              >
                <div className="space-y-1">
                  <h2 className="text-lg font-medium text-primary">
                    {plan.name}
                  </h2>
                  <p className="flex items-baseline gap-1.5">
                    <span className="font-[family-name:var(--font-display)] text-3xl text-primary">
                      {plan.price}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {plan.cadence}
                    </span>
                  </p>
                  <p className="pt-1 text-sm text-muted-foreground">
                    {plan.tagline}
                  </p>
                </div>

                <ul className="mt-5 flex-1 space-y-2.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2.5 text-sm">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {plan.caveat && (
                  <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                    {plan.caveat}
                  </p>
                )}

                <div className="mt-6">
                  {plan.id === "free" && (
                    <Link
                      href="/sign-up"
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        "w-full"
                      )}
                    >
                      Start free
                    </Link>
                  )}

                  {plan.id === "orbit" && (
                    <Link
                      href="/settings#settings-plan"
                      className={cn(buttonVariants({ size: "sm" }), "w-full")}
                    >
                      Choose Orbit
                    </Link>
                  )}

                  {isLifetime && (
                    <div className="space-y-2">
                      <span
                        className={cn(
                          buttonVariants({ variant: "outline", size: "sm" }),
                          "pointer-events-none w-full opacity-60"
                        )}
                        aria-disabled="true"
                      >
                        {soldOut ? "Sold out" : "Coming soon"}
                      </span>
                      <p className="text-center text-xs text-muted-foreground">
                        {soldOut
                          ? "All Lifetime spots have been claimed."
                          : `${remainingSeats} of ${LIFETIME_SEAT_LIMIT} spots remaining.`}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-muted-foreground">
          Reaching a plan limit never hides anything. Everything already in your
          orbit stays visible and editable — a limit only stops new contacts
          being added.
        </p>
      </main>
    </div>
  );
}
