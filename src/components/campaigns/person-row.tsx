"use client";

import { useId, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, ExternalLink } from "lucide-react";
import { RankExplanation } from "@/components/campaigns/rank-explanation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { PersonRow } from "@/lib/outreach/people";
import type { OutreachCriteria, OutreachFundingSource, OutreachRankTier } from "@/lib/outreach/types";

const TIER: Record<OutreachRankTier, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  strong: { label: "Strong", variant: "default" },
  possible: { label: "Possible", variant: "secondary" },
  weak: { label: "Weak", variant: "outline" },
  filtered: { label: "Filtered out", variant: "destructive" },
};

function EmailLine({ email, status }: { email: string; status: PersonRow["emailStatus"] }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 text-foreground">
        <CircleCheck className="size-3 text-primary" aria-hidden />
        {email}
        <span className="sr-only">(verified)</span>
      </span>
    );
  }
  if (status === "unavailable" || status === "bounced") {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <CircleX className="size-3" aria-hidden />
        {email} {status === "bounced" ? "(bounced)" : "(unavailable)"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
      <CircleAlert className="size-3" aria-hidden />
      {email} (unverified)
    </span>
  );
}

export function PersonRowItem({
  person,
  criteria,
  busy,
  funding,
  onToggle,
  onExclude,
  onRestore,
  onResearch,
  onResolveDuplicate,
}: {
  person: PersonRow;
  criteria: OutreachCriteria;
  busy: boolean;
  funding: OutreachFundingSource;
  onToggle: (id: string, selected: boolean) => void;
  onExclude: (id: string) => void;
  onRestore: (id: string) => void;
  onResearch: (id: string) => void;
  onResolveDuplicate: (id: string, decision: "distinct" | "merged") => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const excluded = person.status === "excluded";
  const filtered = person.rankTier === "filtered";
  const researching = person.researchState === "queued" || person.researchState === "running";
  const subtitle = [person.headline ?? person.title, person.company, person.location].filter(Boolean).join(" · ");

  return (
    <li className={excluded ? "rounded-2xl border border-border/70 bg-card opacity-70" : "rounded-2xl border border-border/70 bg-card"}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Checkbox
          className="mt-1"
          aria-label={`Select ${person.fullName}`}
          checked={person.status === "selected"}
          disabled={busy || excluded || filtered}
          onCheckedChange={(checked) => onToggle(person.id, Boolean(checked))}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-ink">{person.fullName}</span>
            {person.rankTier && <Badge variant={TIER[person.rankTier].variant}>{TIER[person.rankTier].label}</Badge>}
            {person.researchConfidence && (
              <span className="text-xs text-muted-foreground">{person.researchConfidence} confidence</span>
            )}
            {person.stale && <span className="text-xs text-amber-700 dark:text-amber-400">Re-ranking…</span>}
            {person.origin === "demo" && <Badge variant="outline">Demo</Badge>}
          </div>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {person.email && <EmailLine email={person.email} status={person.emailStatus} />}
            {person.linkedinUrl && (
              <a
                href={person.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                LinkedIn
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {person.flags.existingContactId && <Badge variant="secondary">In your contacts</Badge>}
            {person.flags.previousCampaigns?.[0] && (
              <Badge variant="secondary">Contacted in “{person.flags.previousCampaigns[0].name}”</Badge>
            )}
            {person.flags.suppressed && (
              <Badge variant="destructive">{person.flags.suppressed === "bounced" ? "Email bounced before" : "Asked not to be contacted"}</Badge>
            )}
            {person.possibleDuplicateOf && person.duplicateReview === "pending" && <Badge variant="outline">Possible duplicate</Badge>}
            {researching && <span className="text-muted-foreground">Researching…</span>}
            {excluded && <span className="text-muted-foreground">Excluded</span>}
          </div>
        </div>
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Why?"}
        </Button>
      </div>
      {open && (
        <div id={detailsId} className="space-y-3 border-t border-border/60 px-4 py-3">
          <RankExplanation explanation={person.rankExplanation} criteria={criteria} evidence={person.evidence} />
          <div className="flex flex-wrap gap-2">
            {!researching && !excluded && person.researchState !== "done" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onResearch(person.id)}>
                {funding === "orbit" ? "Research · 1 credit" : "Research on your keys"}
              </Button>
            )}
            {excluded ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRestore(person.id)}>
                Restore
              </Button>
            ) : (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onExclude(person.id)}>
                Exclude
              </Button>
            )}
            {person.possibleDuplicateOf && person.duplicateReview === "pending" && (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onResolveDuplicate(person.id, "merged")}>
                  Same person as another row
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onResolveDuplicate(person.id, "distinct")}>
                  Different people
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
