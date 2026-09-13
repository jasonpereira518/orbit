"use client";

/**
 * The end: who was saved, where they went, and what to do next. One person gets the
 * compact card (accept was the save); several get the list. The receipt page keeps the
 * full account, with Undo.
 */
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowUpRight, Check, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { PlanetBadge } from "@/components/capture/review/planet-badge";
import { acceptedPeople } from "@/lib/capture/review-reducer";
import type { CaptureDecisions, CaptureJobResult } from "@/lib/capture/types";
import { DUR, EASE_HOUSE } from "@/lib/motion";

export function CaptureSaved({
  result,
  decisions,
  onCaptureMore,
}: {
  result: CaptureJobResult;
  decisions: CaptureDecisions;
  onCaptureMore: () => void;
}) {
  const saved = result.saved;
  const accepted = acceptedPeople(result.items, decisions);
  const single = accepted.length === 1 ? accepted[0]! : null;
  const summary = saved
    ? [
        saved.created ? `${saved.created} new` : null,
        saved.updated ? `${saved.updated} updated` : null,
        saved.remindersCreated ? `${saved.remindersCreated} ${saved.remindersCreated === 1 ? "reminder" : "reminders"}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.base, ease: EASE_HOUSE }}
      className="space-y-4 rounded-2xl border border-primary/30 bg-primary/[0.04] p-5 sm:p-6"
    >
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-[family-name:var(--font-display)] text-2xl text-ink">
            {single
              ? `${single.decision.edits?.name || single.item.parsed.name || "Saved"} is in your orbit`
              : accepted.length
                ? `${accepted.length} people are in your orbit`
                : "Saved"}
          </h2>
          {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
        </div>
      </div>

      {single && saved?.contactIdByKey[single.item.key] && (
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2">
          <PlanetBadge index={single.index} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{single.decision.edits?.name || single.item.parsed.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[single.decision.edits?.company ?? single.item.parsed.company, single.decision.edits?.role ?? single.item.parsed.role].filter(Boolean).join(" · ")}
            </p>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {single.decision.mergeContactId ? "Updated" : "New"}
          </Badge>
        </div>
      )}

      {accepted.length > 1 && saved && (
        <ul className="space-y-1.5">
          {accepted.map(({ item, decision, index }) => {
            const id = saved.contactIdByKey[item.key];
            const name = decision.edits?.name || item.parsed.name || "Unnamed";
            return (
              <li key={item.key} className="flex items-center gap-3 rounded-xl bg-card px-3 py-1.5 text-sm">
                <PlanetBadge index={index} size="xs" />
                {id ? (
                  <Link href={`/contacts/${id}`} className="min-w-0 flex-1 truncate font-medium text-primary hover:underline">
                    {name}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                )}
                <Badge variant="secondary" className="text-[10px]">
                  {decision.mergeContactId ? "Updated" : "New"}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={onCaptureMore}>
          <Sparkles className="size-4" /> Capture more
        </Button>
        {single && saved?.contactIdByKey[single.item.key] && (
          <Link href={`/contacts/${saved.contactIdByKey[single.item.key]}`} className={buttonVariants({ variant: "outline" })}>
            Open contact <ArrowUpRight className="size-3.5" />
          </Link>
        )}
        {saved?.batchId && (
          <Link href={`/capture/${saved.batchId}`} className={buttonVariants({ variant: "ghost", className: "text-muted-foreground" })}>
            See everything created
          </Link>
        )}
      </div>
    </motion.div>
  );
}
