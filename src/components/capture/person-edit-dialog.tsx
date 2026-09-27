"use client";

/**
 * Edit one accepted person from the summary. The same fields as the card, in a dialog;
 * Done writes the decision back and the row re-renders from it.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClosenessControl } from "@/components/capture/review/closeness-control";
import { PersonFields } from "@/components/capture/review/person-fields";
import { PlanetBadge } from "@/components/capture/review/planet-badge";
import { SaveTargetChoice } from "@/components/capture/review/save-target-choice";
import type { PersonDraft } from "@/components/capture/review/person-card";
import type { BulkNotePersonPreview } from "@/lib/capture/types";

export function PersonEditDialog({
  open,
  onOpenChange,
  item,
  index,
  draft,
  onDone,
  lockedName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: BulkNotePersonPreview;
  index: number;
  draft: PersonDraft;
  onDone: (next: PersonDraft) => void;
  lockedName?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <EditBody item={item} index={index} initial={draft} lockedName={lockedName} onDone={(next) => { onDone(next); onOpenChange(false); }} />
      )}
    </Dialog>
  );
}

function EditBody({
  item,
  index,
  initial,
  lockedName,
  onDone,
}: {
  item: BulkNotePersonPreview;
  index: number;
  initial: PersonDraft;
  lockedName?: string | null;
  onDone: (next: PersonDraft) => void;
}) {
  // Local draft: Cancel discards, Done commits. The dialog unmounts on close, so a
  // reopened dialog always starts from the committed decision.
  const [draft, setDraft] = useState<PersonDraft>(initial);
  const lowConfidence = new Set(item.parsed.low_confidence_fields || []);
  return (
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <div className="flex items-center gap-3 pr-8">
          <PlanetBadge index={index} size="sm" />
          <div className="min-w-0">
            <DialogTitle className="truncate font-[family-name:var(--font-display)] text-xl font-normal text-ink">
              {draft.fields.name.trim() || "Unnamed person"}
            </DialogTitle>
            <DialogDescription>Change anything before it&apos;s saved.</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <PersonFields
        idPrefix={`edit-${index}`}
        value={draft.fields}
        onChange={(patch) => setDraft((d) => ({ ...d, fields: { ...d.fields, ...patch } }))}
        lowConfidence={lowConfidence}
        topics={item.parsed.topics}
        sharedNoteTexts={item.sharedNoteTexts}
        sourceText={item.notes}
        compact
      />
      <div className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3">
        <SaveTargetChoice
          name={`edit-${index}-target`}
          candidates={item.duplicates}
          value={draft.mergeContactId}
          onChange={(mergeContactId) => setDraft((d) => ({ ...d, mergeContactId }))}
          lockedName={lockedName}
        />
        <ClosenessControl name={`edit-${index}-closeness`} value={draft.closeness} onChange={(closeness) => setDraft((d) => ({ ...d, closeness }))} />
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => onDone(draft)}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
