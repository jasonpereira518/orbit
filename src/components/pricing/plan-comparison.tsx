import { Check, Minus } from "lucide-react";
import {
  PLAN_CONFIG,
  PLAN_LABELS,
  type PurchasablePlan,
} from "@/lib/plans/plan-config";
import { cn } from "@/lib/utils";

type Cell = boolean | string;
type Column = "free" | PurchasablePlan;

/** The plans on sale. Lifetime is granted, never sold, so it has no column. */
const COLUMNS: Column[] = ["free", "orbit", "max"];

/** Mirrors the tier cards, so a column and its card read as the same thing. */
const COLUMN_ACCENT: Record<Column, { heading: string; tick: string; tint?: string }> = {
  free: { heading: "text-[#e8f3f1]", tick: "text-[#6f8b84]" },
  orbit: {
    heading: "text-brand-pro",
    tick: "text-brand-pro",
    tint: "bg-brand-pro/5",
  },
  max: { heading: "text-[#f2c14e]", tick: "text-[#f2c14e]", tint: "bg-[#f2c14e]/5" },
};

const hours = (seconds: number) =>
  seconds === 0 ? false : `${seconds / 3600} hour${seconds === 3600 ? "" : "s"} a month`;
const each = <T,>(fn: (plan: Column) => T): [T, T, T] => [fn("free"), fn("orbit"), fn("max")];
const feature = (key: keyof (typeof PLAN_CONFIG)["free"]["features"]) =>
  each((plan) => PLAN_CONFIG[plan].features[key]);

/**
 * Every cell is read from `PLAN_CONFIG` — the same object the gates enforce — so the table
 * cannot promise what a gate refuses. Only SHIPPED features appear: Outreach, Events and the
 * Chrome extension stay behind their coming-soon gates and out of this table until they ship.
 *
 * The first block is ungated in code on every plan (capture, chat, the map, LinkedIn import,
 * reminders, the knowledge base, export, and the Claude/ChatGPT connector). On the Free Plan,
 * the AI parts of it run on the person's own key.
 */
const ROWS: Array<{ label: string; cells: [Cell, Cell, Cell] }> = [
  {
    label: "Contacts",
    cells: each((plan) => (PLAN_CONFIG[plan].contactLimit === null ? "Unlimited" : `Up to ${PLAN_CONFIG[plan].contactLimit}`)),
  },
  {
    label: "AI for capture, chat and summaries",
    cells: each((plan) => {
      const credits = PLAN_CONFIG[plan].monthlyCredits;
      return credits ? `Included: ${credits} credits a month` : "Your own key";
    }),
  },
  { label: "Credit packs ($5 = 250 credits)", cells: feature("creditPacks") },
  { label: "Capture with AI extraction", cells: [true, true, true] },
  { label: "Chat with your network", cells: [true, true, true] },
  { label: "Constellation map", cells: [true, true, true] },
  { label: "LinkedIn import", cells: [true, true, true] },
  { label: "Reminders and follow-up feed", cells: [true, true, true] },
  { label: "Knowledge base", cells: [true, true, true] },
  { label: "Export your data", cells: [true, true, true] },
  // Free on every plan: it is how most people will first see what Orbit is for.
  { label: "Use from Claude and ChatGPT", cells: [true, true, true] },
  {
    label: "Google and Microsoft accounts (mail, contacts, calendar)",
    cells: each((plan) => (PLAN_CONFIG[plan].googleMicrosoftConnections === 1 ? "One" : "Both")),
  },
  { label: "Recruiter tracking", cells: feature("recruiters") },
  { label: "Calendar subscriptions", cells: feature("sync") },
  { label: "Meeting transcription", cells: each((plan) => hours(PLAN_CONFIG[plan].speech.meetingSeconds)) },
  { label: "Voice notes and chat mic", cells: each((plan) => hours(PLAN_CONFIG[plan].speech.shortformSeconds)) },
  {
    label: "Contact enrichment",
    cells: each((plan) => {
      const n = PLAN_CONFIG[plan].hostedEnrichmentsPerMonth;
      return n > 0 ? `${n} a month` : "Your own Apollo key";
    }),
  },
  { label: "REST API and webhooks", cells: feature("api") },
];

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
