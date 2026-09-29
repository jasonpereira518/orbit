"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { ANNUAL_SAVING_PERCENT, type BillingPeriod } from "@/lib/plan-copy";

/**
 * Shared between /pricing and /upgrade so the same monthly/annual choice a buyer makes on
 * one page carries the same look on the other.
 *
 * Native radios inside a fieldset: arrow-key navigation, grouping, and the checked state
 * all come from the platform rather than from re-implemented ARIA.
 */
export function BillingToggle({
  period,
  onChange,
}: {
  period: BillingPeriod;
  onChange: (next: BillingPeriod) => void;
}) {
  const name = useId();

  return (
    <fieldset className="mx-auto w-fit">
      <legend className="sr-only">Billing period</legend>
      <div className="flex items-center gap-1 rounded-full border border-[#e8f3f1]/[0.12] bg-[#05070f]/70 p-1 backdrop-blur-sm">
        {(["monthly", "annual"] as const).map((value) => {
          const selected = period === value;
          return (
            <label
              key={value}
              className={cn(
                "relative cursor-pointer rounded-full px-4 py-2 text-sm transition-colors",
                selected ? "text-[#0f2e28]" : "text-[#9aada8] hover:text-[#e8f3f1]",
                "focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#f2c14e]"
              )}
            >
              <input
                type="radio"
                name={name}
                value={value}
                checked={selected}
                onChange={() => onChange(value)}
                className="sr-only"
              />
              {selected && (
                <motion.span
                  layoutId="pricing-period-pill"
                  className="absolute inset-0 -z-10 rounded-full bg-[#eef7f4]"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span className="relative whitespace-nowrap">
                {value === "monthly" ? "Monthly" : "Annual"}
                {value === "annual" && (
                  <span
                    className={cn(
                      "ml-1.5 text-xs",
                      selected ? "text-[#0f2e28]/70" : "text-[#f2c14e]"
                    )}
                  >
                    −{ANNUAL_SAVING_PERCENT}%
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
