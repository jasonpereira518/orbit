import { Check, Minus } from "lucide-react";
import { PLAN_CONFIG, PLAN_LABELS, type Plan, type PlanConfig } from "@/lib/plans/plan-config";
import {
  COMPARISON_COLUMNS as COLUMNS,
  comparisonRows,
  type ComparisonCell as Cell,
  type ComparisonColumn as Column,
} from "@/lib/plan-copy";
import { cn } from "@/lib/utils";
import { ScrollRegion } from "@/components/ui/scroll-region";

/** Mirrors the tier cards, so a column and its card read as the same thing. */
const COLUMN_ACCENT: Record<Column, { heading: string; tick: string; tint?: string }> = {
  free: { heading: "text-[#e8f3f1]", tick: "text-[#6f8b84]" },
  orbit: {
    heading: "text-night-pro",
    tick: "text-night-pro",
    tint: "bg-night-pro/5",
  },
  max: { heading: "text-night-max", tick: "text-night-max", tint: "bg-night-max/5" },
};

function CellValue({ value, plan }: { value: Cell; plan: Column }) {
  if (typeof value === "string") {
    return <span className="text-sm text-[#cfdcd8]">{value}</span>;
  }
  return value ? (
    <>
      <Check
        className={cn("mx-auto size-4", COLUMN_ACCENT[plan].tick)}
        aria-hidden="true"
      />
      <span className="sr-only">Included</span>
    </>
  ) : (
    <>
      <Minus className="mx-auto size-4 text-[#3f4f4b]" aria-hidden="true" />
      <span className="sr-only">Not included</span>
    </>
  );
}

/**
 * Every cell is read from the EFFECTIVE plan table and page tier rules (`comparisonRows`) —
 * what the gates enforce — so the table cannot promise what a gate refuses. Only shipped
 * features appear. The rows with no gate at all (export, the Claude/ChatGPT
 * connector) are ticks on every plan.
 */
export function PlanComparison({
  config = PLAN_CONFIG,
  tierRules,
}: {
  config?: Record<Plan, PlanConfig>;
  tierRules?: ReadonlyMap<string, readonly Plan[]>;
}) {
  const rows = comparisonRows(config, tierRules);
  return (
    <>
    <div className="space-y-3 sm:hidden" aria-label="Compare plans">
      {COLUMNS.map((plan, index) => (
        <details key={plan} className="rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/50 p-4">
          <summary className={cn("min-h-11 cursor-pointer py-2 text-base font-medium", COLUMN_ACCENT[plan].heading)}>{PLAN_LABELS[plan]} features</summary>
          <dl className="mt-3 divide-y divide-[#e8f3f1]/10">
            {rows.map((row) => <div key={row.label} className="flex items-center justify-between gap-4 py-3"><dt className="text-sm text-[#cfdcd8]">{row.label}</dt><dd className="min-w-0 max-w-[55%] break-words text-right"><CellValue value={row.cells[index]} plan={plan} /></dd></div>)}
          </dl>
        </details>
      ))}
    </div>
    {/* Keep the complete comparison in a contained scroller on larger screens. */}
    <ScrollRegion
      label="Plan comparison"
      className="hidden rounded-3xl border border-[#e8f3f1]/[0.10] bg-[#05070f]/50 backdrop-blur-sm sm:block"
    >
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <caption className="sr-only">Feature comparison across Orbit plans</caption>
        <thead>
          <tr className="border-b border-[#e8f3f1]/[0.08]">
            <th scope="col" className="px-6 py-4 text-sm font-normal text-[#9aada8]">
              What you get
            </th>
            {COLUMNS.map((plan) => (
              <th
                key={plan}
                scope="col"
                className={cn(
                  "px-4 py-4 text-center text-sm font-medium",
                  COLUMN_ACCENT[plan].heading,
                  COLUMN_ACCENT[plan].tint
                )}
              >
                {PLAN_LABELS[plan]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className="border-b border-[#e8f3f1]/[0.05] last:border-b-0"
            >
              <th
                scope="row"
                className="px-6 py-3.5 text-sm font-normal text-[#cfdcd8]"
              >
                {row.label}
              </th>
              {row.cells.map((cell, i) => (
                <td
                  key={COLUMNS[i]}
                  className={cn(
                    "px-4 py-3.5 text-center",
                    COLUMN_ACCENT[COLUMNS[i]].tint
                  )}
                >
                  <CellValue value={cell} plan={COLUMNS[i]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
    </>
  );
}
