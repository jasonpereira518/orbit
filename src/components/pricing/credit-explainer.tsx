import { CREDIT_PACK_CREDITS, CREDIT_PACK_PRICE_CENTS } from "@/lib/stripe-config";
import { PLAN_CONFIG, formatPlanPrice } from "@/lib/plans/plan-config";

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

/**
 * "What's a credit?" — the short, honest version. States what a credit is measured in
 * (Orbit's real provider cost), what each plan includes, how packs behave, and what happens
 * at zero. Numbers come from the plan table and the Stripe config, never typed in here.
 */
export function CreditExplainer() {
  const pack = formatPlanPrice(CREDIT_PACK_PRICE_CENTS);
  const points = [
    {
      title: "Measured, not estimated",
      body: "One credit is one cent of what the AI actually costs Orbit at its provider's rates. Every call is metered from the tokens it really used, so a quick chat answer is a fraction of a credit and a long meeting summary is more.",
    },
    {
      title: "A monthly allowance",
      body: `Orbit Pro includes ${PLAN_CONFIG.orbit.monthlyCredits} credits a month and Orbit Max ${PLAN_CONFIG.max.monthlyCredits}. The allowance resets when your plan renews and does not roll over.`,
    },
    {
      title: "Packs, only if you want them",
      body: `A ${pack} pack adds ${CREDIT_PACK_CREDITS} credits. Pack credits roll over while you're subscribed and are used only after the monthly allowance runs out.`,
    },
    {
      title: "Nothing automatic",
      body: "At zero, AI pauses until your allowance resets, you add a pack, or you switch to your own key. Calls on your own key never use credits.",
    },
  ];
  return (
    <div>
      <h2 id="pricing-credits" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
        What&rsquo;s a credit?
      </h2>
      <dl className="mx-auto mt-10 grid max-w-4xl gap-x-10 gap-y-7 sm:grid-cols-2">
        {points.map((point) => (
          <div key={point.title}>
            <dt className="text-sm font-medium text-[#e8f3f1]">{point.title}</dt>
            <dd className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">{point.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
