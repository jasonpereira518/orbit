import { ExternalLink } from "lucide-react";
import { KIND_LABEL } from "@/components/campaigns/criteria-editor";
import type { PersonEvidence } from "@/lib/outreach/people";
import type { OutreachCriteria, OutreachRankExplanation, OutreachVerdict } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

const VERDICT: Record<OutreachVerdict, { symbol: string; label: string; className: string }> = {
  match: { symbol: "✓", label: "Matches", className: "text-primary" },
  partial: { symbol: "~", label: "Partly matches", className: "text-amber-600 dark:text-amber-400" },
  unknown: { symbol: "?", label: "Not enough information", className: "text-muted-foreground" },
  mismatch: { symbol: "✗", label: "Doesn’t match", className: "text-destructive" },
  conflicting: { symbol: "⚠", label: "Sources disagree", className: "text-amber-600 dark:text-amber-400" },
};

export function RankExplanation({
  explanation,
  criteria,
  evidence,
}: {
  explanation: OutreachRankExplanation | null;
  criteria: OutreachCriteria;
  evidence: PersonEvidence[];
}) {
  if (!explanation) return <p className="text-sm text-muted-foreground">Not ranked yet.</p>;
  const lookup = new Map(
    (["required", "preferred", "exclusions"] as const).flatMap((group) =>
      criteria[group].map((c) => [c.id, { label: c.label, kind: c.kind, group }] as const)
    )
  );
  const sources = new Map(evidence.map((e, index) => [e.id, { ...e, n: index + 1 }]));
  return (
    <div className="space-y-2">
      {explanation.summary && <p className="text-sm text-foreground">{explanation.summary}</p>}
      {explanation.filteredReason && <p className="text-sm text-destructive">{explanation.filteredReason}</p>}
      <ul className="space-y-1.5">
        {explanation.criteria.map((verdict) => {
          const criterion = lookup.get(verdict.criterionId);
          if (!criterion) return null;
          const style = VERDICT[verdict.verdict];
          return (
            <li key={verdict.criterionId} className="flex items-start gap-2 text-sm">
              <span aria-hidden className={cn("w-4 shrink-0 text-center font-medium", style.className)}>
                {style.symbol}
              </span>
              <span className="min-w-0">
                <span className="text-ink">{criterion.label}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {KIND_LABEL[criterion.kind]}
                  {criterion.group === "exclusions" ? " · exclusion" : criterion.group === "preferred" ? " · preferred" : ""}
                </span>
                <span className="sr-only">: {style.label}</span>
                {verdict.note && <span className="block text-xs text-muted-foreground">{verdict.note}</span>}
                {verdict.evidenceIds.length > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    Source{" "}
                    {verdict.evidenceIds.map((id) => {
                      const source = sources.get(id);
                      return source ? (
                        <span key={id} className="mr-1">
                          [{source.n}]
                        </span>
                      ) : null;
                    })}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {evidence.length > 0 && (
        <ol className="space-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          {evidence.map((e, index) => (
            <li key={e.id} className="flex gap-1.5">
              <span>[{index + 1}]</span>
              <span className="min-w-0">
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                    {e.title || e.url}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : (
                  <span className="text-foreground">{e.title}</span>
                )}
                {e.snippet && <span className="block line-clamp-2">{e.snippet}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
