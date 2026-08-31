import { Building2, Clock } from "lucide-react";
import type { PipelineOpportunity } from "@/actions/recruiter-pipeline";
import { RECRUITER_STAGES, type RecruiterStage } from "@/lib/recruiter-stages";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The pipeline, grouped by stage.
 *
 * A server component — nothing here is interactive, so it costs no client JS. Stage order
 * comes from `RECRUITER_STAGES` rather than being re-listed, so adding a stage cannot leave
 * the board silently dropping it.
 */

/** Live stages first, then the ones that are over. */
const STAGE_ORDER: RecruiterStage[] = [
  "offer",
  "interviewing",
  "screening",
  "in_conversation",
  "applied",
  "outreach_received",
  "outreach_sent",
  "rejected",
  "withdrawn",
];

const STAGE_TONE: Record<RecruiterStage, string> = {
  offer: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  interviewing: "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  screening: "border-teal-500/30 bg-teal-500/5 text-teal-700 dark:text-teal-300",
  in_conversation: "border-border/70 bg-muted/40 text-foreground",
  applied: "border-border/70 bg-muted/40 text-muted-foreground",
  outreach_received: "border-border/70 bg-muted/30 text-muted-foreground",
  outreach_sent: "border-border/70 bg-muted/30 text-muted-foreground",
  rejected: "border-border/60 bg-muted/20 text-muted-foreground",
  withdrawn: "border-border/60 bg-muted/20 text-muted-foreground",
};

function relativeDate(iso: string | null): string {
  if (!iso) return "no dated activity";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

function OpportunityCard({ opportunity }: { opportunity: PipelineOpportunity }) {
  return (
    <li className="rounded-xl border border-border/70 bg-card px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-medium text-ink">{opportunity.companyName}</p>
        <p className="text-xs text-muted-foreground">
          {relativeDate(opportunity.lastActivityAt)}
        </p>
      </div>

      {opportunity.roles.length > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          {opportunity.roles.join(" · ")}
        </p>
      )}

      {opportunity.summary && (
        <p className="mt-2 text-sm text-foreground/90">{opportunity.summary}</p>
      )}

      {opportunity.nextStep && (
        <p className="mt-2 text-sm text-foreground">
          <span className="text-muted-foreground">Next: </span>
          {opportunity.nextStep}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {opportunity.threadCount}{" "}
          {opportunity.threadCount === 1 ? "thread" : "threads"}
        </span>
        {opportunity.isStale && (
          <Badge variant="outline" className="gap-1 font-normal">
            <Clock className="h-3 w-3" />
            Quiet for a while
          </Badge>
        )}
      </div>

      {/* The quote the stage was read from. Shown because a stage with no visible basis is
          a claim the user has no way to check. */}
      {opportunity.stageEvidence && (
        <p className="mt-2 border-l-2 border-border/70 pl-3 text-xs italic text-muted-foreground">
          “{opportunity.stageEvidence.trim().slice(0, 160)}”
        </p>
      )}
    </li>
  );
}

export function PipelineBoard({
  opportunities,
}: {
  opportunities: PipelineOpportunity[];
}) {
  if (opportunities.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-12 text-center">
        <Building2 className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-3 font-medium text-ink">No hiring processes yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Scan your Gmail and Orbit will group your recruiter threads into one
          process per company, with the stage each one has reached.
        </p>
      </div>
    );
  }

  const byStage = new Map<RecruiterStage, PipelineOpportunity[]>();
  for (const opportunity of opportunities) {
    const list = byStage.get(opportunity.stage) ?? [];
    list.push(opportunity);
    byStage.set(opportunity.stage, list);
  }

  // Defensive: a stage absent from STAGE_ORDER would otherwise vanish from the board.
  const ordered = [
    ...STAGE_ORDER,
    ...RECRUITER_STAGES.filter((s) => !STAGE_ORDER.includes(s)),
  ];

  return (
    <div className="space-y-6">
      {ordered.map((stage) => {
        const items = byStage.get(stage);
        if (!items || items.length === 0) return null;
        return (
          <section key={stage}>
            <div className="mb-2 flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                  STAGE_TONE[stage]
                )}
              >
                {items[0].stageLabel}
              </span>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </div>
            <ul className="space-y-2">
              {items.map((opportunity) => (
                <OpportunityCard key={opportunity.id} opportunity={opportunity} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
