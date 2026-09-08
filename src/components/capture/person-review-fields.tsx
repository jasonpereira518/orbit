"use client";

/**
 * The editable body of one extracted person, lifted verbatim out of `PersonReviewCard` in
 * `bulk-notes-panel.tsx` when the review carousel became a list.
 *
 * Fully controlled: no internal item state, one `onChange` that replaces the whole item.
 * That contract is what lets the list hold every person's edits in one array and key the
 * updates rather than index them — with rows arriving progressively, index identity is not
 * stable.
 *
 * The one piece of local state is `showSource`, which used to live in the single visible
 * card and now has to be per row.
 */

import { useState } from "react";
import Link from "next/link";
import type { ParsedNote } from "@/lib/ai";
import type { ReviewItem } from "@/lib/capture-review-item";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function PersonReviewFields({
  item,
  onChange,
  compact,
  preferredContactId,
  preferredContactName,
  lockedParticipantName,
}: {
  item: ReviewItem;
  onChange: (next: ReviewItem) => void;
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  lockedParticipantName?: string | null;
}) {
  const updateParsed = (patch: Partial<ParsedNote>) =>
    onChange({ ...item, parsed: { ...item.parsed, ...patch } });

  const lowConfidence = new Set(item.parsed.low_confidence_fields || []);
  const [showSource, setShowSource] = useState(false);

  const showPreferred =
    preferredContactId &&
    preferredContactName &&
    !item.duplicates.some((d) => d.id === preferredContactId);

  return (
    <div className={cn("space-y-3", !compact && "space-y-4")}>
      <div
        className={cn(
          "grid gap-2.5",
          compact ? "grid-cols-1" : "sm:grid-cols-2 gap-3"
        )}
      >
        <Field label="Name" lowConfidence={lowConfidence.has("name")}>
          <Input
            value={item.parsed.name || ""}
            onChange={(e) => updateParsed({ name: e.target.value })}
          />
        </Field>
        <Field label="Company" lowConfidence={lowConfidence.has("company")}>
          <Input
            value={item.parsed.company || ""}
            onChange={(e) => updateParsed({ company: e.target.value })}
          />
        </Field>
        <Field label="Role" lowConfidence={lowConfidence.has("role")}>
          <Input
            value={item.parsed.role || ""}
            onChange={(e) => updateParsed({ role: e.target.value })}
          />
        </Field>
        <Field label="Met at" lowConfidence={lowConfidence.has("met_at")}>
          <Input
            value={item.parsed.met_at || ""}
            onChange={(e) => updateParsed({ met_at: e.target.value })}
          />
        </Field>
        <Field label="Tags">
          <Input
            value={item.tagNames}
            onChange={(e) => onChange({ ...item, tagNames: e.target.value })}
          />
        </Field>
      </div>

      {!compact && (
        <Field label="Summary">
          <Textarea
            value={item.parsed.summary || ""}
            onChange={(e) => updateParsed({ summary: e.target.value })}
          />
        </Field>
      )}

      {compact && item.parsed.summary && (
        <p className="text-xs text-muted-foreground sm:text-sm">
          {item.parsed.summary}
        </p>
      )}

      {item.sharedNoteTexts.length > 0 && (
        <div className="rounded-xl border border-sky-200/70 bg-sky-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-sky-900/40 dark:bg-sky-950/15">
          <p className="mb-1 font-medium text-foreground">Shared with others</p>
          {item.sharedNoteTexts.map((text) => (
            <p key={text.slice(0, 40)} className="whitespace-pre-wrap">
              {text}
            </p>
          ))}
        </div>
      )}

      {item.notes.trim() && (
        <div>
          <button
            type="button"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? "Hide source text" : "Show source text"}
          </button>
          {showSource && (
            <p className="mt-1.5 whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {item.notes}
            </p>
          )}
        </div>
      )}

      {(item.parsed.topics || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.parsed.topics.map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/30 p-2.5">
        {item.locked ? (
          <p className="text-xs text-muted-foreground">
            Logging on{" "}
            <span className="font-medium text-foreground">
              {lockedParticipantName}
            </span>
            &apos;s timeline
          </p>
        ) : (
          <>
            <p className="text-xs font-medium">Save as</p>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`merge-${item.key}`}
                checked={!item.mergeContactId}
                onChange={() => onChange({ ...item, mergeContactId: null })}
              />
              Create new contact
            </label>
            {showPreferred && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`merge-${item.key}`}
                  checked={item.mergeContactId === preferredContactId}
                  onChange={() =>
                    onChange({ ...item, mergeContactId: preferredContactId })
                  }
                />
                Merge into {preferredContactName}
              </label>
            )}
            {item.duplicates.map((d) => (
              <label key={d.id} className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  className="mt-0.5"
                  name={`merge-${item.key}`}
                  checked={item.mergeContactId === d.id}
                  onChange={() => onChange({ ...item, mergeContactId: d.id })}
                />
                <span>
                  Update{" "}
                  <Link
                    href={`/contacts/${d.id}`}
                    className="text-primary underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {d.fullName}
                  </Link>
                  {d.company ? ` (${d.company})` : ""}
                </span>
              </label>
            ))}
          </>
        )}
      </div>

      <div
        className={cn(
          "grid gap-2.5",
          compact ? "grid-cols-2" : "sm:grid-cols-3 gap-3"
        )}
      >
        <Field label="Closeness">
          <Input
            type="number"
            min={1}
            max={5}
            value={item.relationshipScore}
            onChange={(e) =>
              onChange({
                ...item,
                relationshipScore: Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Follow-up days">
          <Input
            type="number"
            min={1}
            value={item.followUpDays}
            onChange={(e) =>
              onChange({ ...item, followUpDays: Number(e.target.value) })
            }
          />
        </Field>
        <label
          className={cn(
            "flex items-center gap-2 text-xs",
            compact ? "col-span-2" : "items-end pb-2 text-sm"
          )}
        >
          <Checkbox
            checked={item.createReminder}
            onCheckedChange={(v) =>
              onChange({ ...item, createReminder: Boolean(v) })
            }
          />
          Reminder
        </label>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  lowConfidence,
}: {
  label: string;
  children: React.ReactNode;
  lowConfidence?: boolean;
}) {
  return (
    <div className={cn("space-y-1", lowConfidence && "rounded-lg")}>
      <Label
        className={cn(
          "text-xs",
          lowConfidence && "text-amber-700 dark:text-amber-400"
        )}
      >
        {label}
        {lowConfidence ? " *" : ""}
      </Label>
      <div
        className={cn(
          lowConfidence &&
            "rounded-md ring-1 ring-amber-500/50 ring-offset-1 ring-offset-background"
        )}
      >
        {children}
      </div>
    </div>
  );
}
