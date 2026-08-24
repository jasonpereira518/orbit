import { Check, Minus } from "lucide-react";
import {
  FREE_CONTACT_LIMIT,
  PLAN_LABELS,
  type Plan,
} from "@/lib/plan-limits";
import { cn } from "@/lib/utils";

type Cell = boolean | string;

const COLUMNS: Plan[] = ["free", "orbit", "lifetime"];

/** Mirrors the tier cards, so a column and its card read as the same thing. */
const COLUMN_ACCENT: Record<Plan, { heading: string; tick: string; tint?: string }> = {
  free: { heading: "text-[#e8f3f1]", tick: "text-[#6f8b84]" },
  orbit: {
    heading: "text-[#599de7]",
    tick: "text-[#599de7]",
    tint: "bg-[#599de7]/[0.05]",
  },
  lifetime: { heading: "text-[#f2c14e]", tick: "text-[#f2c14e]" },
};

/**
 * Every row here is checked against `entitlements.ts`, which is the only place a gate is
 * decided — not against what the tiers *say*. Worth knowing before editing:
 *
 *  - The first block is ungated in code. Capture, chat, the map, LinkedIn import,
 *    reminders, the knowledge base, and export never consult entitlements at all, so they
 *    are true on every plan and stay grouped together.
 *  - `canUseOutreach`, `canUseRecruiters`, `canUseSync`, `canUseExtension`, and
 *    `canUseHostedSending` are all plain `plan !== "free"`, so Lifetime matches Pro on
 *    each of them. Sending included: it is capped at `DAILY_SEND_LIMIT` a day on every
 *    plan, so it is a bounded cost a one-time payment can carry.
 *  - `canUseHostedEnrichment` is the ONLY entitlement that separates the two paid tiers,
 *    so "Contact enrichment" must stay the only row whose Pro and Lifetime cells differ.
 *    It gates Orbit's *own* Apollo key, never a key the user supplied — see the
 *    personal-key short-circuit at the top of `getApolloApiKey`. That is why enrichment
 *    reads "Your own key" on Free and Lifetime rather than a cross: anyone who pastes an
 *    Apollo key into Settings gets it.
 */
const ROWS: Array<{ label: string; cells: [Cell, Cell, Cell] }> = [
  {
    label: "Contacts",
    cells: [`Up to ${FREE_CONTACT_LIMIT}`, "Unlimited", "Unlimited"],
  },
  { label: "Capture with AI extraction", cells: [true, true, true] },
  { label: "Chat with your network", cells: [true, true, true] },
  { label: "Constellation map", cells: [true, true, true] },
  { label: "LinkedIn import", cells: [true, true, true] },
  { label: "Reminders and follow-up feed", cells: [true, true, true] },
  { label: "Knowledge base", cells: [true, true, true] },
  { label: "Export your data", cells: [true, true, true] },
  { label: "Recruiter tracking", cells: [false, true, true] },
  { label: "Gmail, Outlook, calendar sync", cells: [false, true, true] },
  { label: "Chrome extension", cells: [false, true, true] },
  { label: "Outreach campaigns", cells: [false, true, true] },
  { label: "Email and SMS sending", cells: [false, true, true] },
  {
    label: "Contact enrichment",
    cells: ["Your own key", "Orbit's credits", "Your own key"],
  },
  { label: "AI provider key", cells: ["Yours", "Yours", "Yours"] },
];

function CellValue({ value, plan }: { value: Cell; plan: Plan }) {
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

export function PlanComparison() {
  return (
    // Wide content scrolls inside its own container so the page body never scrolls
    // sideways on a phone.
    <div className="overflow-x-auto rounded-3xl border border-[#e8f3f1]/[0.10] bg-[#05070f]/50 backdrop-blur-sm">
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
          {ROWS.map((row) => (
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
    </div>
  );
}
