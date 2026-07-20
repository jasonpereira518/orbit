"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatHowMetSummary } from "@/lib/met-context";
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
  onContactPatch,
}: {
  selection: InspectSelection;
  onClose: () => void;
  onContactPatch?: (
    id: string,
    patch: Partial<GraphNodeData>
  ) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
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
        className="w-full border-l border-primary/20 bg-gradient-to-b from-card to-muted sm:max-w-md"
      >
        {selection?.type === "user" && (
          <>
            <SheetHeader>
              <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-primary">
                {selection.data.label}
              </SheetTitle>
              <SheetDescription>Center of your solar system</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="rounded-xl border border-primary/15 bg-primary p-4 text-primary-foreground shadow-lg">
                <p className="text-2xl font-semibold">{selection.summary.total}</p>
                <p className="text-sm text-primary-foreground/70">people in orbit</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-primary/12 bg-card/70 p-3">
                  <p className="text-lg font-medium text-primary">
                    {selection.summary.companyCount}
                  </p>
                  <p className="text-xs text-muted-foreground">companies</p>
                </div>
                <div className="rounded-xl border border-primary/12 bg-card/70 p-3">
                  <p className="text-lg font-medium text-primary">
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
                      className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-accent/60"
                    >
                      <span>
                        {RING_LABELS[score]}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          ({score})
                        </span>
                      </span>
                      <span className="text-primary">
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
          <ContactPanelBody
            id={selection.id}
            data={selection.data}
            pending={pending}
            start={start}
            onContactPatch={onContactPatch}
            onRefresh={() => router.refresh()}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ContactPanelBody({
  id,
  data,
  pending,
  start,
  onContactPatch,
  onRefresh,
}: {
  id: string;
  data: GraphNodeData;
  pending: boolean;
  start: (fn: () => void | Promise<void>) => void;
  onContactPatch?: (id: string, patch: Partial<GraphNodeData>) => void;
  onRefresh: () => void;
}) {
  const howMet = formatHowMetSummary({
    metContext: data.metContext,
    dateMet: data.dateMet,
    howMet: data.howMet,
  });

  return (
    <>
      <SheetHeader>
        <div className="flex items-start gap-3 pr-8">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-primary-foreground",
              "bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.35),transparent_42%)] bg-primary",
              "shadow-[0_0_16px_rgba(15,61,62,0.35)]",
              data.dormant && "opacity-70",
              data.overdue && "ring-2 ring-[#c4a35a]"
            )}
          >
            {data.initials}
          </div>
          <div className="min-w-0">
            <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-primary">
              {data.label}
            </SheetTitle>
            {data.fullName &&
              data.preferredName &&
              data.preferredName !== data.fullName && (
                <p className="text-xs text-muted-foreground">{data.fullName}</p>
              )}
            <SheetDescription>
              {[data.title, data.company].filter(Boolean).join(" · ") ||
                "Contact in your network"}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="space-y-4 overflow-y-auto px-4 pb-2">
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            {RING_LABELS[data.score || 2] || "Orbit"}
            {typeof data.closeness === "number"
              ? ` · ${Math.round(data.closeness * 100)}% close`
              : ` · ${data.score}/5`}
          </span>
          {data.closenessTier && (
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs capitalize text-muted-foreground">
              {data.closenessTier} orbit
            </span>
          )}
          {typeof data.relationshipScore === "number" && (
            <span className="rounded-full border border-primary/15 px-2.5 py-1 text-xs text-muted-foreground">
              Manual {data.relationshipScore}/5
            </span>
          )}
          {data.dormant && (
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              Dormant
            </span>
          )}
          {data.overdue && (
            <span className="rounded-full bg-chart-4/15 px-2.5 py-1 text-xs font-medium text-chart-4">
              Follow-up overdue
            </span>
          )}
        </div>

        {(data.tags || []).length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Tags
            </p>
            <div className="flex flex-wrap gap-1.5">
              {data.tags!.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-primary/15 bg-card/70 px-2 py-0.5 text-xs"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4 border-b border-primary/10 py-2">
            <span className="text-muted-foreground">Last interaction</span>
            <span className="text-right text-primary">
              {formatMaybeRelative(data.lastInteractionAt) ||
                formatMaybeDate(data.lastInteractionAt) ||
                "Never"}
            </span>
          </div>
          <div className="flex justify-between gap-4 border-b border-primary/10 py-2">
            <span className="text-muted-foreground">Next follow-up</span>
            <span className="text-right text-primary">
              {formatMaybeDate(data.nextFollowUpAt) || "None"}
            </span>
          </div>
          {howMet && (
            <div className="border-b border-primary/10 py-2">
              <p className="text-muted-foreground">How you met</p>
              <p className="mt-1 text-primary">{howMet}</p>
            </div>
          )}
        </div>

        {(data.email || data.phone || data.linkedinUrl) && (
          <div className="flex flex-wrap gap-2">
            {data.email && (
              <a
                href={`mailto:${data.email}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Email
              </a>
            )}
            {data.phone && (
              <a
                href={`tel:${data.phone}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Call
              </a>
            )}
            {data.linkedinUrl && (
              <a
                href={data.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                LinkedIn
              </a>
            )}
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              AI summary
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const res = await regenerateContactSummary(id);
                    if (res.summary) {
                      onContactPatch?.(id, { aiSummary: res.summary });
                    }
                    toast.success("Summary updated");
                    onRefresh();
                  } catch (err) {
                    toast.error(
                      err instanceof Error
                        ? err.message
                        : "Could not generate summary"
                    );
                  }
                })
              }
            >
              {pending ? "…" : data.aiSummary ? "Refresh" : "Generate"}
            </Button>
          </div>
          {data.aiSummary ? (
            <p className="text-sm leading-relaxed text-foreground/90">
              {data.aiSummary}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No summary yet. Generate one from how you met and past
              conversations.
            </p>
          )}
        </div>

        {(data.keyFacts || []).length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Key facts
            </p>
            <ul className="list-inside list-disc space-y-1 text-sm text-foreground/90">
              {data.keyFacts!.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <SheetFooter className="gap-2 sm:flex-col">
        <EasyFollowUp
          contactId={id}
          nextFollowUpAt={data.nextFollowUpAt}
          className="w-full rounded-xl border border-border/50 bg-card/50 p-3"
          onScheduled={(dueDate) => {
            onContactPatch?.(id, {
              nextFollowUpAt: dueDate,
              overdue: false,
            });
            onRefresh();
          }}
        />
        <Link
          href={`/contacts/${id}`}
          className={cn(
            buttonVariants(),
            "w-full bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          Open full profile
        </Link>
        <Link
          href={`/capture?contactId=${id}`}
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Log interaction
        </Link>
      </SheetFooter>
    </>
  );
}
