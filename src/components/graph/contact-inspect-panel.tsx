"use client";

import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RING_LABELS, type GraphNodeData } from "@/lib/graph-layout";

export type InspectSelection =
  | { type: "contact"; id: string; data: GraphNodeData }
  | {
      type: "user";
      data: GraphNodeData;
      summary: {
        total: number;
        companyCount: number;
        scoreCounts: Record<number, number>;
      };
    }
  | null;

function formatMaybeDate(value: string | null | undefined) {
  if (!value) return null;
  try {
    return format(new Date(value), "MMM d, yyyy");
  } catch {
    return null;
  }
}

function formatMaybeRelative(value: string | null | undefined) {
  if (!value) return null;
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return null;
  }
}

export function ContactInspectPanel({
  selection,
  onClose,
}: {
  selection: InspectSelection;
  onClose: () => void;
}) {
  const open = selection !== null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full border-l border-[#0f3d3e]/20 bg-[linear-gradient(180deg,#f7faf8_0%,#eef3ef_100%)] sm:max-w-md"
      >
        {selection?.type === "user" && (
          <>
            <SheetHeader>
              <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-[#0f3d3e]">
                {selection.data.label}
              </SheetTitle>
              <SheetDescription>Center of your solar system</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="rounded-xl border border-[#0f3d3e]/15 bg-[#0f3d3e] p-4 text-[#e8f3f1] shadow-lg">
                <p className="text-2xl font-semibold">{selection.summary.total}</p>
                <p className="text-sm text-[#7aa896]">people in orbit</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[#0f3d3e]/12 bg-white/70 p-3">
                  <p className="text-lg font-medium text-[#0f3d3e]">
                    {selection.summary.companyCount}
                  </p>
                  <p className="text-xs text-muted-foreground">companies</p>
                </div>
                <div className="rounded-xl border border-[#0f3d3e]/12 bg-white/70 p-3">
                  <p className="text-lg font-medium text-[#0f3d3e]">
                    {(selection.summary.scoreCounts[4] || 0) +
                      (selection.summary.scoreCounts[5] || 0)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    strong ties (4–5)
                  </p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  By orbit
                </p>
                <ul className="space-y-1.5 text-sm">
                  {[5, 4, 3, 2, 1].map((score) => (
                    <li
                      key={score}
                      className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-white/60"
                    >
                      <span>
                        {RING_LABELS[score]}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          ({score})
                        </span>
                      </span>
                      <span className="text-[#0f3d3e]">
                        {selection.summary.scoreCounts[score] || 0}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}

        {selection?.type === "contact" && (
          <>
            <SheetHeader>
              <div className="flex items-start gap-3 pr-8">
                <div
                  className={cn(
                    "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-[#e8f3f1]",
                    "bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.35),transparent_42%),#0f3d3e]",
                    "shadow-[0_0_16px_rgba(15,61,62,0.35)]",
                    selection.data.dormant && "opacity-70",
                    selection.data.overdue && "ring-2 ring-[#c4a35a]"
                  )}
                >
                  {selection.data.initials}
                </div>
                <div className="min-w-0">
                  <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-[#0f3d3e]">
                    {selection.data.label}
                  </SheetTitle>
                  {selection.data.fullName &&
                    selection.data.preferredName &&
                    selection.data.preferredName !== selection.data.fullName && (
                      <p className="text-xs text-muted-foreground">
                        {selection.data.fullName}
                      </p>
                    )}
                  <SheetDescription>
                    {[selection.data.title, selection.data.company]
                      .filter(Boolean)
                      .join(" · ") || "Contact in your network"}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-4 overflow-y-auto px-4 pb-2">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-[#0f3d3e]/10 px-2.5 py-1 text-xs font-medium text-[#0f3d3e]">
                  {RING_LABELS[selection.data.score || 2] || "Orbit"} ·{" "}
                  {selection.data.score}/5
                </span>
                {selection.data.dormant && (
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    Dormant
                  </span>
                )}
                {selection.data.overdue && (
                  <span className="rounded-full bg-[#c4a35a]/15 px-2.5 py-1 text-xs font-medium text-[#8a6f2e]">
                    Follow-up overdue
                  </span>
                )}
              </div>

              {(selection.data.tags || []).length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Tags
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {selection.data.tags!.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-md border border-[#0f3d3e]/15 bg-white/70 px-2 py-0.5 text-xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-2 text-sm">
                <div className="flex justify-between gap-4 border-b border-[#0f3d3e]/10 py-2">
                  <span className="text-muted-foreground">Last interaction</span>
                  <span className="text-right text-[#0f3d3e]">
                    {formatMaybeRelative(selection.data.lastInteractionAt) ||
                      formatMaybeDate(selection.data.lastInteractionAt) ||
                      "Never"}
                  </span>
                </div>
                <div className="flex justify-between gap-4 border-b border-[#0f3d3e]/10 py-2">
                  <span className="text-muted-foreground">Next follow-up</span>
                  <span className="text-right text-[#0f3d3e]">
                    {formatMaybeDate(selection.data.nextFollowUpAt) || "None"}
                  </span>
                </div>
              </div>

              {selection.data.aiSummary && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Summary
                  </p>
                  <p className="text-sm leading-relaxed text-foreground/90">
                    {selection.data.aiSummary}
                  </p>
                </div>
              )}

              {(selection.data.keyFacts || []).length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Key facts
                  </p>
                  <ul className="list-inside list-disc space-y-1 text-sm text-foreground/90">
                    {selection.data.keyFacts!.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <SheetFooter>
              <Link
                href={`/contacts/${selection.id}`}
                className={cn(
                  buttonVariants(),
                  "w-full bg-[#0f3d3e] text-white hover:bg-[#0c3233]"
                )}
              >
                Open full profile
              </Link>
              <Link
                href={`/capture?contactId=${selection.id}`}
                className={cn(buttonVariants({ variant: "outline" }), "w-full")}
              >
                Log interaction
              </Link>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
