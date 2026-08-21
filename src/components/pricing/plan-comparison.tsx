import { Check, Minus } from "lucide-react";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";
import { cn } from "@/lib/utils";

type Cell = boolean | string;

const COLUMNS = ["Free", "Orbit Pro", "Orbit Lifetime"] as const;

const ROWS: Array<{ label: string; cells: [Cell, Cell, Cell] }> = [
  {
    label: "Contacts",
    cells: [`${FREE_CONTACT_LIMIT}`, "Unlimited", "Unlimited"],
  },
  { label: "Capture with AI extraction", cells: [true, true, true] },
  { label: "Chat with your network", cells: [true, true, true] },
  { label: "Constellation map", cells: [true, true, true] },
  { label: "LinkedIn import", cells: [true, true, true] },
  { label: "Reminders and follow-up feed", cells: [true, true, true] },
  { label: "Knowledge base", cells: [true, true, true] },
  { label: "Recruiter tracking", cells: [false, true, true] },
  { label: "Gmail, Outlook, calendar sync", cells: [false, true, true] },
  { label: "Chrome extension", cells: [false, true, true] },
  { label: "Outreach campaigns", cells: [false, true, "Your own keys"] },
  { label: "Sending on Orbit's credits", cells: [false, true, false] },
  {
    label: "AI provider key",
    cells: ["Yours", "Yours", "Yours"],
  },
  { label: "Export your data", cells: [true, true, true] },
];

function CellValue({ value, featured }: { value: Cell; featured: boolean }) {
  if (typeof value === "string") {
    return <span className="text-sm text-[#cfdcd8]">{value}</span>;
  }
  return value ? (
    <>
      <Check
        className={cn(
          "mx-auto size-4",
          featured ? "text-[#f2c14e]" : "text-[#6f8b84]"
        )}
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
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={cn(
                  "px-4 py-4 text-center text-sm font-medium",
                  col === "Orbit Pro" ? "text-[#f2c14e]" : "text-[#e8f3f1]"
                )}
              >
                {col}
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
                    i === 1 && "bg-[#f2c14e]/[0.04]"
                  )}
                >
                  <CellValue value={cell} featured={i === 1} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
