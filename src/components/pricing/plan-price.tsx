import type { PlanPrice } from "@/lib/plan-copy";

/**
 * A plan's price, painted in the first frame and never animated: the price is the one thing
 * on the page that must always be readable, including in a throttled or backgrounded tab.
 * Pricing v2 has no billing-period toggle, so there is nothing for it to change into.
 */
export function PlanPriceDisplay({ price }: { price: PlanPrice }) {
  return (
    <div>
      <p className="flex items-baseline gap-1.5">
        <span className="font-[family-name:var(--font-display)] text-[42px] leading-none tracking-tight tabular-nums text-[#e8f3f1]">
          {price.amount}
        </span>
        <span className="text-sm text-[#9aada8]">{price.cadence}</span>
      </p>
      {price.footnote && <p className="mt-2 text-xs text-[#9aada8]">{price.footnote}</p>}
    </div>
  );
}
