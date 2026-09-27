"use client";

/**
 * One person, one card. Presentational: the deck owns the drag, the decisions and the
 * order; this lays out the header band (the drag handle), the planet, the fields, where
 * to save, and how close you are. The same draft shape feeds the edit dialog.
 */
import { Badge } from "@/components/ui/badge";
import { ClosenessControl } from "@/components/capture/review/closeness-control";
import { PersonFields, type PersonFieldValues } from "@/components/capture/review/person-fields";
import { PlanetBadge } from "@/components/capture/review/planet-badge";
import { SaveTargetChoice } from "@/components/capture/review/save-target-choice";
import type { ClosenessLevel } from "@/lib/capture/closeness";
import type { BulkNotePersonPreview } from "@/lib/capture/types";
import { cn } from "@/lib/utils";

export type PersonDraft = {
  fields: PersonFieldValues;
  mergeContactId: string | null;
  closeness: ClosenessLevel;
};

export function PersonCardBody({
  item,
  index,
  total,
  draft,
  onDraft,
  lockedName,
  handleProps,
  headerExtra,
  compact = false,
  idPrefix,
}: {
  item: BulkNotePersonPreview;
  /** Card position — also the planet. */
  index: number;
  total: number;
  draft: PersonDraft;
  onDraft: (patch: Partial<PersonDraft>) => void;
  lockedName?: string | null;
  /** Spread onto the header band so a drag can start there (and only there). */
  handleProps?: React.HTMLAttributes<HTMLDivElement>;
  headerExtra?: React.ReactNode;
  compact?: boolean;
  idPrefix: string;
}) {
  const lowConfidence = new Set(item.parsed.low_confidence_fields || []);
  const name = draft.fields.name.trim() || "Unnamed person";
  const subline = [draft.fields.company.trim(), draft.fields.role.trim()].filter(Boolean).join(" · ");
  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      <div
        {...handleProps}
        className={cn(
          "relative -m-5 mb-0 rounded-t-2xl px-5 pt-5 pb-3 sm:-m-6 sm:mb-0 sm:px-6 sm:pt-6",
          handleProps && "cursor-grab touch-pan-y select-none active:cursor-grabbing",
          handleProps && "bg-gradient-to-b from-muted/40 to-transparent"
        )}
      >
        <div className="flex items-start gap-4 pr-16">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {index + 1} of {total}
            </p>
            <h3 className="mt-0.5 truncate font-[family-name:var(--font-display)] text-2xl leading-tight text-ink">{name}</h3>
            {subline && <p className="mt-0.5 truncate text-sm text-muted-foreground">{subline}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {draft.mergeContactId && (
                <Badge variant="secondary" className="text-[10px]">
                  Already in your network
                </Badge>
              )}
              {item.sharedNoteTexts.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  Includes shared note
                </Badge>
              )}
              {headerExtra}
            </div>
          </div>
        </div>
        <PlanetBadge
          index={index}
          size={compact ? "sm" : "md"}
          title={`Card ${index + 1} of ${total}`}
          className={cn("absolute -top-2 right-4 drop-shadow-md sm:right-5", compact && "top-3")}
        />
        {handleProps && (
          <span aria-hidden className="mx-auto mt-2 block h-1 w-10 rounded-full bg-border/80" />
        )}
      </div>

      <PersonFields
        idPrefix={idPrefix}
        value={draft.fields}
        onChange={(patch) => onDraft({ fields: { ...draft.fields, ...patch } })}
        lowConfidence={lowConfidence}
        topics={item.parsed.topics}
        sharedNoteTexts={item.sharedNoteTexts}
        sourceText={item.notes}
        compact={compact}
      />

      <div className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3">
        <SaveTargetChoice
          name={`${idPrefix}-target`}
          candidates={item.duplicates}
          value={draft.mergeContactId}
          onChange={(mergeContactId) => onDraft({ mergeContactId })}
          lockedName={lockedName}
        />
        <ClosenessControl
          name={`${idPrefix}-closeness`}
          value={draft.closeness}
          onChange={(closeness) => onDraft({ closeness })}
        />
      </div>
    </div>
  );
}
