"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "@/lib/toast";
import {
  confirmBulkCapture,
  parseBulkCaptureNotes,
  type BulkNotePersonPreview,
} from "@/actions/capture";
import { getSettings } from "@/actions/settings";
import type { ParsedNote, SharedNoteContext } from "@/lib/ai";
import { toUserFacingError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Decision = "pending" | "accepted" | "discarded";

type ReviewItem = BulkNotePersonPreview & {
  decision: Decision;
  mergeContactId: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string;
  followUpDays: number;
};

export function BulkNotesPanel({
  compact = false,
  preferredContactId = null,
  preferredContactName = null,
  hasApiKey: hasApiKeyProp,
  onSaved,
}: {
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  /** When known from the server, skips a settings round-trip. */
  hasApiKey?: boolean;
  /** Called after a successful save. Defaults to staying on the paste step. */
  onSaved?: (result: {
    created: number;
    updated: number;
    contactIds: string[];
  }) => void;
}) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const fileRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [step, setStep] = useState<"paste" | "review" | "done">("paste");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteContext[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<1 | -1>(1);
  const [hasApiKey, setHasApiKey] = useState(hasApiKeyProp ?? true);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (hasApiKeyProp !== undefined) {
      setHasApiKey(hasApiKeyProp);
      return;
    }
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setHasApiKey(settings.hasApiKey);
      })
      .catch(() => {
        // Keep extract enabled; the action returns a clear error if needed.
      });
    return () => {
      cancelled = true;
    };
  }, [hasApiKeyProp]);

  const accepted = items.filter((i) => i.decision === "accepted");
  const discarded = items.filter((i) => i.decision === "discarded");
  const current = items[reviewIndex] ?? null;
  const isLastCard = reviewIndex >= items.length - 1 && items.length > 0;

  function resetToPaste() {
    setStep("paste");
    setNotes("");
    setFileName(null);
    setItems([]);
    setSharedNotes([]);
    setReviewIndex(0);
  }

  function decide(decision: "accepted" | "discarded") {
    if (!current) return;
    setSlideDirection(1);
    setItems((prev) =>
      prev.map((item, i) =>
        i === reviewIndex ? { ...item, decision } : item
      )
    );
    if (reviewIndex >= items.length - 1) {
      setStep("done");
    } else {
      setReviewIndex((i) => i + 1);
    }
  }

  function goBack() {
    if (reviewIndex <= 0) {
      setStep("paste");
      return;
    }
    setSlideDirection(-1);
    setReviewIndex((i) => i - 1);
    setItems((prev) =>
      prev.map((item, i) =>
        i === reviewIndex - 1 ? { ...item, decision: "pending" } : item
      )
    );
    setStep("review");
  }

  function saveAccepted() {
    start(async () => {
      try {
        const payload = accepted.map((i) => ({
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
        if (!payload.length) {
          toast.error("No contacts to save — accept at least one person");
          return;
        }
        const res = await confirmBulkCapture(payload);
        toast.success(
          `Saved: ${res.created} created, ${res.updated} updated`
        );
        if (onSaved) {
          onSaved(res);
        } else {
          resetToPaste();
          router.refresh();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      {step === "paste" && (
        <div
          className={cn(
            "space-y-3",
            !compact && "rounded-2xl border border-border/70 bg-card p-6 space-y-4"
          )}
        >
          {!hasApiKey && (
            <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
              <p className="font-medium text-foreground">
                Add an AI API key to extract people from notes
              </p>
              <p className="mt-1 text-muted-foreground">
                Orbit needs your Gemini, OpenAI, or Anthropic key — add one in{" "}
                <Link
                  href="/settings"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Settings
                </Link>
                , then come back here.
              </p>
            </div>
          )}
          {preferredContactId && preferredContactName && (
            <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Logging with{" "}
              <span className="font-medium text-foreground">
                {preferredContactName}
              </span>{" "}
              preferred for merge when they appear in the notes. You can still
              extract and review everyone else.
            </p>
          )}
          <div>
            <Label htmlFor="bulk-notes">Paste or upload notes</Label>
            {!compact && (
              <p className="mt-1 text-sm text-muted-foreground">
                Drop in notes about one person or many — Orbit splits profiles
                out, keeps shared event/group context attached to each, and you
                review one card at a time.
              </p>
            )}
            {compact && (
              <p className="mt-1 text-xs text-muted-foreground">
                Multi-person notes → extract → review one by one → save.
              </p>
            )}
            <Textarea
              id="bulk-notes"
              className={cn("mt-2", compact ? "min-h-[140px]" : "min-h-[220px]")}
              placeholder={
                compact
                  ? `Met Sarah Chen at AWS Summit — Codex partnerships at OpenAI...\n\nMarcus Lee (Stripe) offered an intro...`
                  : `AWS Summit afterparty — talked with a few people over drinks about AI tooling.\n\nMet Sarah Chen — she leads Codex partnerships at OpenAI...\n\nAlso caught up with Marcus Lee (Stripe, recruiting). He offered an intro to their AI infra team...\n\nQuick note on Priya Nair from the same night — still at Notion, exploring agent workflows.`
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
            disabled={pending || !notes.trim() || !hasApiKey}
            size={compact ? "sm" : "default"}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
            onClick={() =>
              start(async () => {
                try {
                  const res = await parseBulkCaptureNotes(notes);
                  if (!res.ok) {
                    toast.error(res.error);
                    if (/api key/i.test(res.error)) setHasApiKey(false);
                    return;
                  }
                  setSharedNotes(res.sharedNotes || []);
                  setItems(
                    res.items.map((item) => {
                      const preferredMatch =
                        preferredContactId &&
                        item.duplicates.some((d) => d.id === preferredContactId)
                          ? preferredContactId
                          : null;
                      return {
                        ...item,
                        decision: "pending" as const,
                        mergeContactId:
                          preferredMatch || item.suggestedMergeId,
                        createReminder: Boolean(
                          item.parsed.follow_up_recommendation
                        ),
                        relationshipScore:
                          item.parsed.relationship_score_suggestion || 2,
                        tagNames: (item.parsed.tags || []).join(", "),
                        followUpDays: item.parsed.follow_up_days || 14,
                      };
                    })
                  );
                  setReviewIndex(0);
                  setSlideDirection(1);
                  setStep("review");
                  toast.success(
                    `Found ${res.items.length} ${res.items.length === 1 ? "person" : "people"}`
                  );
                } catch (err) {
                  toast.error(
                    toUserFacingError(
                      err,
                      "Could not parse notes. Add your AI API key in Settings and try again."
                    ).message
                  );
                }
              })
            }
          >
            {pending ? "Parsing…" : "Extract people"}
          </Button>
        </div>
      )}

      {step === "review" && current && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                className={cn(
                  "font-medium text-primary",
                  compact ? "text-base" : "text-lg"
                )}
              >
                {reviewIndex + 1} of {items.length}
              </h2>
              <p className="text-xs text-muted-foreground">
                Edit if needed, then accept or discard. Shared notes stay on
                matching people.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={goBack}>
              Back
            </Button>
          </div>

          <div className="flex gap-1.5" aria-hidden>
            {items.map((item, i) => (
              <span
                key={item.key}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  i < reviewIndex && item.decision === "accepted"
                    ? "bg-primary"
                    : i < reviewIndex && item.decision === "discarded"
                      ? "bg-muted-foreground/30"
                      : i === reviewIndex
                        ? "bg-primary/60"
                        : "bg-muted"
                )}
              />
            ))}
          </div>

          {sharedNotes.length > 0 && reviewIndex === 0 && (
            <div className="space-y-2 rounded-2xl border border-sky-200/80 bg-sky-50/60 p-3 dark:border-sky-900/50 dark:bg-sky-950/20">
              <p className="text-xs font-medium text-primary">
                Shared context ({sharedNotes.length}) — applied to matching
                people
              </p>
              {sharedNotes.slice(0, 2).map((shared, idx) => (
                <p
                  key={`${idx}-${shared.text.slice(0, 24)}`}
                  className="text-xs text-muted-foreground line-clamp-2"
                >
                  {shared.text}
                </p>
              ))}
            </div>
          )}

          <div className="relative overflow-hidden">
            <AnimatePresence mode="wait" custom={slideDirection}>
              <motion.div
                key={current.key}
                custom={slideDirection}
                initial={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: slideDirection * 48, rotate: slideDirection * 1.5 }
                }
                animate={{ opacity: 1, x: 0, rotate: 0 }}
                exit={
                  reduceMotion
                    ? { opacity: 0 }
                    : {
                        opacity: 0,
                        x: slideDirection * -56,
                        rotate: slideDirection * -2,
                      }
                }
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <PersonReviewCard
                  item={current}
                  compact={compact}
                  preferredContactId={preferredContactId}
                  preferredContactName={preferredContactName}
                  onChange={(next) =>
                    setItems((prev) =>
                      prev.map((p, i) => (i === reviewIndex ? next : p))
                    )
                  }
                />
              </motion.div>
            </AnimatePresence>
          </div>

          <div
            className={cn(
              "grid grid-cols-2 gap-2",
              compact &&
                "sticky bottom-0 -mx-1 border-t border-border/60 bg-card pt-3"
            )}
          >
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              disabled={pending}
              onClick={() => decide("discarded")}
            >
              Discard
            </Button>
            <Button
              type="button"
              size={compact ? "sm" : "default"}
              disabled={pending || !current.parsed.name?.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => decide("accepted")}
            >
              {isLastCard ? "Accept" : "Accept & next"}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div
          className={cn(
            "space-y-4",
            !compact && "rounded-2xl border border-border/70 bg-card p-6"
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2
                className={cn(
                  "font-medium text-primary",
                  compact ? "text-base" : "text-lg"
                )}
              >
                Ready to save
              </h2>
              <p className="text-xs text-muted-foreground">
                {accepted.length} accepted
                {discarded.length > 0 ? `, ${discarded.length} discarded` : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSlideDirection(-1);
                setReviewIndex(Math.max(0, items.length - 1));
                setItems((prev) =>
                  prev.map((item, i) =>
                    i === items.length - 1
                      ? { ...item, decision: "pending" }
                      : item
                  )
                );
                setStep("review");
              }}
            >
              Back
            </Button>
          </div>

          {accepted.length > 0 ? (
            <ul className="space-y-2">
              {accepted.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-sm"
                >
                  <span className="font-medium">
                    {item.parsed.name}
                    {item.parsed.company ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {item.parsed.company}
                      </span>
                    ) : null}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
                    {item.mergeContactId ? "Update" : "New"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              You discarded everyone. Go back to review again, or start over.
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              onClick={resetToPaste}
            >
              Start over
            </Button>
            <Button
              type="button"
              size={compact ? "sm" : "default"}
              disabled={pending || accepted.length === 0}
              className="bg-primary text-primary-foreground hover:bg-primary/90 sm:flex-1"
              onClick={saveAccepted}
            >
              {pending
                ? "Saving…"
                : `Save ${accepted.length} ${accepted.length === 1 ? "contact" : "contacts"}`}
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
  preferredContactId,
  preferredContactName,
}: {
  item: ReviewItem;
  onChange: (next: ReviewItem) => void;
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
}) {
  const updateParsed = (patch: Partial<ParsedNote>) =>
    onChange({ ...item, parsed: { ...item.parsed, ...patch } });

  const showPreferred =
    preferredContactId &&
    preferredContactName &&
    !item.duplicates.some((d) => d.id === preferredContactId);

  return (
    <div
      className={cn(
        "space-y-3 rounded-2xl border border-border/70 bg-card shadow-sm",
        compact ? "p-3.5" : "p-5 space-y-4"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {item.parsed.name || "Unnamed person"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {item.sharedNoteTexts.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              Includes shared note
            </Badge>
          )}
          {item.suggestedMergeId && (
            <Badge variant="secondary" className="text-[10px]">
              Likely existing
            </Badge>
          )}
        </div>
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
        <Field label="Met at">
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
