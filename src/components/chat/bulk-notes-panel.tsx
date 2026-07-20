"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  confirmBulkCapture,
  parseBulkCaptureNotes,
  type BulkNotePersonPreview,
} from "@/actions/capture";
import type { ParsedNote } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ReviewItem = BulkNotePersonPreview & {
  include: boolean;
  mergeContactId: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string;
  followUpDays: number;
};

export function BulkNotesPanel({ compact = false }: { compact?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [pending, start] = useTransition();

  const includedCount = items.filter((i) => i.include).length;

  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      {step === "paste" && (
        <div
          className={cn(
            "space-y-3",
            !compact && "rounded-2xl border border-border/70 bg-card p-6 space-y-4"
          )}
        >
          <div>
            <Label htmlFor="bulk-notes">Paste or upload notes</Label>
            {!compact && (
              <p className="mt-1 text-sm text-muted-foreground">
                Drop in a dump of meeting notes, coffee chats, or follow-ups —
                Orbit will split out each person and update matching contacts.
              </p>
            )}
            {compact && (
              <p className="mt-1 text-xs text-muted-foreground">
                Multi-person notes → extract → review → save.
              </p>
            )}
            <Textarea
              id="bulk-notes"
              className={cn("mt-2", compact ? "min-h-[140px]" : "min-h-[220px]")}
              placeholder={
                compact
                  ? `Met Sarah Chen at AWS Summit — Codex partnerships at OpenAI...\n\nMarcus Lee (Stripe) offered an intro...`
                  : `Met Sarah Chen at AWS Summit — she leads Codex partnerships at OpenAI...\n\nAlso caught up with Marcus Lee (Stripe, recruiting). He offered an intro to their AI infra team...\n\nQuick note on Priya Nair from last week's alumni dinner — still at Notion, exploring agent workflows.`
              }
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                setNotes(text);
                setFileName(file.name);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              onClick={() => fileRef.current?.click()}
            >
              Upload .txt / .md
            </Button>
            {fileName && (
              <span className="truncate text-xs text-muted-foreground">
                {fileName}
              </span>
            )}
          </div>

          <Button
            disabled={pending || !notes.trim()}
            size={compact ? "sm" : "default"}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
            onClick={() =>
              start(async () => {
                try {
                  const res = await parseBulkCaptureNotes(notes);
                  setItems(
                    res.items.map((item) => ({
                      ...item,
                      include: true,
                      mergeContactId: item.suggestedMergeId,
                      createReminder: Boolean(
                        item.parsed.follow_up_recommendation
                      ),
                      relationshipScore:
                        item.parsed.relationship_score_suggestion || 2,
                      tagNames: (item.parsed.tags || []).join(", "),
                      followUpDays: item.parsed.follow_up_days || 14,
                    }))
                  );
                  setStep("review");
                  toast.success(
                    `Found ${res.items.length} ${res.items.length === 1 ? "person" : "people"}`
                  );
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Failed to parse notes"
                  );
                }
              })
            }
          >
            {pending ? "Parsing…" : "Extract people"}
          </Button>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                className={cn(
                  "font-medium text-primary",
                  compact ? "text-base" : "text-lg"
                )}
              >
                Review {items.length}{" "}
                {items.length === 1 ? "person" : "people"}
              </h2>
              <p className="text-xs text-muted-foreground">
                Confirm creates and merges before saving.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setStep("paste")}>
              Back
            </Button>
          </div>

          <div className="space-y-3">
            {items.map((item, index) => (
              <PersonReviewCard
                key={item.key}
                item={item}
                compact={compact}
                onChange={(next) =>
                  setItems((prev) =>
                    prev.map((p, i) => (i === index ? next : p))
                  )
                }
              />
            ))}
          </div>

          <div
            className={cn(
              compact &&
                "sticky bottom-0 -mx-1 border-t border-border/60 bg-card pt-3"
            )}
          >
            <Button
              disabled={pending || includedCount === 0}
              size={compact ? "sm" : "default"}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() =>
                start(async () => {
                  try {
                    const payload = items
                      .filter((i) => i.include)
                      .map((i) => ({
                        notes: i.notes,
                        parsed: i.parsed,
                        mergeContactId: i.mergeContactId,
                        createReminder: i.createReminder,
                        relationshipScore: i.relationshipScore,
                        tagNames: i.tagNames
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean),
                        followUpDays: i.followUpDays,
                      }));
                    const res = await confirmBulkCapture(payload);
                    toast.success(
                      `Saved: ${res.created} created, ${res.updated} updated`
                    );
                    setStep("paste");
                    setNotes("");
                    setFileName(null);
                    setItems([]);
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Save failed"
                    );
                  }
                })
              }
            >
              {pending
                ? "Saving…"
                : `Confirm & save ${includedCount} ${includedCount === 1 ? "contact" : "contacts"}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonReviewCard({
  item,
  onChange,
  compact,
}: {
  item: ReviewItem;
  onChange: (next: ReviewItem) => void;
  compact?: boolean;
}) {
  const updateParsed = (patch: Partial<ParsedNote>) =>
    onChange({ ...item, parsed: { ...item.parsed, ...patch } });

  return (
    <div
      className={cn(
        "space-y-3 rounded-2xl border border-border/70 bg-card",
        compact ? "p-3.5" : "p-5 space-y-4",
        !item.include && "opacity-60"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={item.include}
            onCheckedChange={(v) =>
              onChange({ ...item, include: Boolean(v) })
            }
          />
          Include
        </label>
        {item.suggestedMergeId && (
          <Badge variant="secondary" className="text-[10px]">
            Likely existing
          </Badge>
        )}
      </div>

      <div
        className={cn(
          "grid gap-2.5",
          compact ? "grid-cols-1" : "sm:grid-cols-2 gap-3"
        )}
      >
        <Field label="Name">
          <Input
            value={item.parsed.name || ""}
            onChange={(e) => updateParsed({ name: e.target.value })}
          />
        </Field>
        <Field label="Company">
          <Input
            value={item.parsed.company || ""}
            onChange={(e) => updateParsed({ company: e.target.value })}
          />
        </Field>
        <Field label="Role">
          <Input
            value={item.parsed.role || ""}
            onChange={(e) => updateParsed({ role: e.target.value })}
          />
        </Field>
        <Field label="Tags">
          <Input
            value={item.tagNames}
            onChange={(e) => onChange({ ...item, tagNames: e.target.value })}
          />
        </Field>
      </div>

      {item.parsed.summary && (
        <p className="text-xs text-muted-foreground sm:text-sm">
          {item.parsed.summary}
        </p>
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
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
