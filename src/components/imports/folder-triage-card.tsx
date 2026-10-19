"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Contact, FileQuestion, FolderOpen, Users, MessageSquare, UserRound, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Detected, DetectionResult, ImportTarget } from "@/lib/imports/detect-import-file";
import { RUN_ORDER } from "@/lib/imports/import-constants";
import { rankCandidates, type RankedCandidate } from "@/lib/imports/rank-candidates";
import { cn } from "@/lib/utils";

/**
 * The step between choosing a folder and reviewing what it holds.
 *
 * A folder can hold several files Orbit reads, and the import runs one per kind. Instead of
 * quietly keeping the biggest, this ranks them (`rankCandidates`), ticks the one that looks
 * most important in each kind, says why, and lets the person swap it. Ticking a file of a
 * kind unticks the other one — that is the engine's one-per-kind rule, shown as a choice.
 */
const KIND: Record<ImportTarget, { label: string; Icon: typeof Contact }> = {
  linkedin_connections: { label: "LinkedIn connections", Icon: Users },
  linkedin_messages: { label: "LinkedIn messages", Icon: MessageSquare },
  linkedin_profile: { label: "LinkedIn profile", Icon: UserRound },
  linkedin_positions: { label: "LinkedIn current role", Icon: UserRound },
  linkedin_skills: { label: "LinkedIn skills", Icon: UserRound },
  linkedin_alerts: { label: "LinkedIn job alerts", Icon: UserRound },
  linkedin_education: { label: "LinkedIn education", Icon: UserRound },
  linkedin_export: { label: "LinkedIn export files", Icon: Users },
  contacts_file: { label: "Contacts", Icon: Contact },
  calendar_ics: { label: "Calendar", Icon: CalendarDays },
  calendar_csv: { label: "Calendar", Icon: CalendarDays },
  unknown: { label: "Other", Icon: FileQuestion },
};

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FolderTriageCard({
  result,
  onConfirm,
  onCancel,
}: {
  result: DetectionResult;
  /** The person's choice, as a result the queue can stage. */
  onConfirm: (result: DetectionResult) => void;
  onCancel: () => void;
}) {
  const ranked = useMemo(() => rankCandidates(result.candidates), [result.candidates]);
  const [checked, setChecked] = useState<Set<Detected>>(
    () => new Set(ranked.filter((r) => r.suggested).map((r) => r.detected))
  );

  // Kinds in run order, so the list reads the way the import will run.
  const groups = useMemo(() => {
    const byTarget = new Map<ImportTarget, RankedCandidate[]>();
    for (const r of ranked) byTarget.set(r.detected.target, [...(byTarget.get(r.detected.target) ?? []), r]);
    return RUN_ORDER.filter((t) => byTarget.has(t)).map((t) => ({ target: t, items: byTarget.get(t)! }));
  }, [ranked]);

  function toggle(r: RankedCandidate) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(r.detected)) {
        next.delete(r.detected);
      } else {
        // One file per kind: ticking this one puts back whichever was ticked before.
        for (const other of ranked) {
          if (other.detected.target === r.detected.target) next.delete(other.detected);
        }
        next.add(r.detected);
      }
      return next;
    });
  }

  function confirm() {
    const staged = RUN_ORDER.flatMap((t) => [...checked].filter((d) => d.target === t));
    const left = ranked
      .map((r) => r.detected)
      .filter((d) => !checked.has(d))
      .map((d) => ({ ...d, reason: "left unticked" }));
    onConfirm({ ...result, staged, skipped: [...result.skipped, ...left] });
  }

  const otherCount = result.ignored.length;

  return (
    <section
      aria-label="Choose what to import from this folder"
      className="space-y-4 rounded-xl border border-border-subtle bg-card p-5"
    >
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FolderOpen className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-base font-medium text-ink">
            Found {ranked.length} {ranked.length === 1 ? "file" : "files"} Orbit can import
          </h2>
          <p className="text-sm text-muted-foreground">
            The most important one of each kind is ticked for you. Change any of them, then
            review who’s in it before anything is added.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Cancel" onClick={onCancel}>
          <X className="size-4" aria-hidden />
        </Button>
      </header>

      <div className="space-y-4">
        {groups.map(({ target, items }) => {
          const kind = KIND[target];
          return (
            <div key={target} className="space-y-1.5">
              <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <kind.Icon className="size-3.5" aria-hidden />
                </span>
                {kind.label}
                {items.length > 1 ? <span className="font-normal">· pick one</span> : null}
              </p>
              <ul className="space-y-1.5">
                {items.map((r) => {
                  const on = checked.has(r.detected);
                  const where = r.detected.path;
                  return (
                    <li key={`${r.detected.path}/${r.detected.file.name}/${r.detected.file.size}`}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                          on ? "border-primary/40 bg-primary/5" : "border-border-subtle hover:bg-muted/40"
                        )}
                      >
                        <Checkbox checked={on} onCheckedChange={() => toggle(r)} className="mt-1" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-ink">
                              {r.detected.displayName}
                            </span>
                            {r.suggested ? (
                              <Badge tone="success" size="sm">
                                Suggested
                              </Badge>
                            ) : null}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {where ? `${where} · ` : ""}
                            {sizeLabel(r.detected.bytes)} · {r.why}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {otherCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {otherCount} other {otherCount === 1 ? "file" : "files"} in the folder aren’t
          something Orbit reads, so {otherCount === 1 ? "it was" : "they were"} left out.
          {result.truncated ? " The folder was large, so only the first files were checked." : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={checked.size === 0} onClick={confirm}>
          {checked.size === 1 ? "Review 1 file" : `Review ${checked.size} files`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
