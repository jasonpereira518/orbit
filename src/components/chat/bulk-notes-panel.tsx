"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { addDays, format } from "date-fns";
import { toast } from "@/lib/toast";
import {
  confirmBulkCapture,
  ingestCaptureMedia,
  parseBulkCaptureNotes,
  type BulkNotePersonPreview,
  type SuggestedReminderPreview,
} from "@/actions/capture";
import { SuggestedRemindersReview } from "@/components/capture/suggested-reminders-review";
import { AiKeyPanel } from "@/components/settings/ai-key-panel";
import { getSettings } from "@/actions/settings";
import type { SaveNoteBatchOutput } from "@/lib/note-batch-save";
import {
  pickLockedParticipant,
  withLockedSeedPerson,
  type PreviewMention,
} from "@/lib/note-batches";
import type {
  CaptureParseHints,
  ParsedNote,
  SharedNoteContext,
} from "@/lib/ai";
import {
  MISSING_AI_API_KEY_MESSAGE,
  isMissingAiApiKeyError,
  toUserFacingError,
} from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Decision = "pending" | "accepted" | "discarded";

export type SuggestionReviewItem = SuggestedReminderPreview & {
  checked: boolean;
  /**
   * Overrides which person this date belongs to, by name. Names rather than ids
   * because the contacts do not exist yet at review time — the server resolves the
   * name to a contact id after the person loop creates them.
   */
  personNameOverride: string | null;
};

type ReviewItem = BulkNotePersonPreview & {
  decision: Decision;
  mergeContactId: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string;
  followUpDays: number;
  /** Locked to `lockedParticipantId` — the panel was opened from that contact's profile. */
  locked?: boolean;
};

const CAPTURE_FILE_ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".ics",
  ".eml",
  "text/plain",
  "text/markdown",
  "text/calendar",
  "message/rfc822",
  "image/*",
  "audio/*",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
].join(",");

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function BulkNotesPanel({
  compact = false,
  preferredContactId = null,
  preferredContactName = null,
  lockedParticipantId = null,
  lockedParticipantName = null,
  entryPoint,
  hasApiKey: hasApiKeyProp,
  onApiKeyVerified,
  onSaved,
}: {
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  /**
   * When set, the parse is seeded with this person and whichever parsed item matches
   * them is force-merged into this contact and can't be redirected to "Create new" or
   * another merge target — used when the panel is opened from that contact's profile.
   */
  lockedParticipantId?: string | null;
  lockedParticipantName?: string | null;
  /** Where the panel was opened from. Affects the default `onSaved` behavior. */
  entryPoint?: "capture" | "profile";
  /** When known from the server, skips a settings round-trip. */
  hasApiKey?: boolean;
  /** Called when the inline AiKeyPanel verifies a key, in addition to flipping the local state. */
  onApiKeyVerified?: () => void;
  /** Called after a successful save. Defaults to staying on the paste step. */
  onSaved?: (result: SaveNoteBatchOutput) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [captureHints, setCaptureHints] = useState<CaptureParseHints | null>(
    null
  );
  const [ingestSources, setIngestSources] = useState<string[]>([]);
  const [step, setStep] = useState<"paste" | "review" | "done">("paste");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteContext[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<1 | -1>(1);
  const [suggestions, setSuggestions] = useState<SuggestionReviewItem[]>([]);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [sourceHash, setSourceHash] = useState<string | null>(null);
  const [anchorIso, setAnchorIso] = useState<string | null>(null);
  const [anchorBasis, setAnchorBasis] = useState<
    "note" | "hint" | "upload" | null
  >(null);
  const [skipped, setSkipped] = useState<{
    relative: number;
    unverifiable: number;
    past: number;
  } | null>(null);
  const [mentions, setMentions] = useState<PreviewMention[]>([]);
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
  const checkedDates = suggestions.filter((s) => s.checked).length;
  const saveLabel = (() => {
    const parts: string[] = [];
    if (accepted.length) {
      parts.push(
        `${accepted.length} ${accepted.length === 1 ? "contact" : "contacts"}`
      );
    }
    if (checkedDates) {
      parts.push(
        `${checkedDates} ${checkedDates === 1 ? "reminder" : "reminders"}`
      );
    }
    return parts.length ? `Save ${parts.join(" + ")}` : "Save";
  })();

  function resetToPaste() {
    setStep("paste");
    setNotes("");
    setFileName(null);
    setCaptureHints(null);
    setIngestSources([]);
    setItems([]);
    setSharedNotes([]);
    setReviewIndex(0);
    setSuggestions([]);
    setSourceText(null);
    setSourceHash(null);
    setAnchorIso(null);
    setAnchorBasis(null);
    setSkipped(null);
    setMentions([]);
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
          interactionDate: i.interactionDate,
          interactionType: i.interactionType,
        }));
        const checkedSuggestions = suggestions.filter((s) => s.checked);
        if (!payload.length && !checkedSuggestions.length) {
          toast.error("Nothing to save — accept a person or a date");
          return;
        }
        const res = await confirmBulkCapture(payload, {
          sourceHash: sourceHash!,
          sourceText: sourceText!,
          anchorIso: anchorIso!,
          anchorBasis: anchorBasis ?? "upload",
          entryPoint: entryPoint ?? "capture",
          seedContactId: lockedParticipantId ?? null,
          commitments: checkedSuggestions.map((s) => ({
            title: s.title,
            description: s.description,
            rawDatePhrase: s.rawDatePhrase,
            dueDateIso: s.dueDateIso,
            yearInferred: s.yearInferred,
            personName: s.personNameOverride ?? s.personName,
            actionKind: s.actionKind,
            confidenceScore: s.confidenceScore,
            sourceExcerpt: s.sourceExcerpt,
            dateBasis: s.dateBasis,
            anchorIso: s.anchorIso,
          })),
          mentions,
          skipped: skipped ?? { relative: 0, unverifiable: 0, past: 0 },
        });
        // The profile entry point's default path gets its own toast below (a link to
        // the fuller capture results, not a raw count) — every other path shares this
        // one summary toast, so it's hoisted here instead of repeated per branch.
        if (onSaved || entryPoint !== "profile") {
          toast.success(
            `Saved: ${res.created} created, ${res.updated} updated, ${res.remindersCreated} reminders`
          );
        }
        if (onSaved) {
          onSaved(res);
        } else if (entryPoint === "profile") {
          // Stay on the profile — nothing to navigate to here — and offer a link to
          // the fuller capture results (mentions, reminders, dedupe) instead of
          // dragging the user off the page they were already looking at.
          resetToPaste();
          router.refresh();
          toast.success("Saved — view what was created", {
            action: {
              label: "Open",
              onClick: () => router.push(`/capture/${res.batchId}`),
            },
          });
        } else {
          resetToPaste();
          router.push(`/capture/${res.batchId}`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  function handleFilesSelected(fileList: FileList | null) {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    start(async () => {
      try {
        const payloads = await Promise.all(
          files.map(async (file) => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            base64: await fileToBase64(file),
          }))
        );
        const res = await ingestCaptureMedia({
          text: notes,
          files: payloads,
        });
        if (!res.ok) {
          const missingKey = isMissingAiApiKeyError(res.error);
          if (missingKey) setHasApiKey(false);
          toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error);
          return;
        }
        setNotes(res.text);
        setCaptureHints(res.hints || null);
        setIngestSources(res.sources || []);
        setFileName(
          files.length === 1
            ? files[0]!.name
            : `${files.length} files ingested`
        );
        toast.success("Input ready — review the text, then extract people");
      } catch (err) {
        toast.error(
          toUserFacingError(err, "Could not read that file").message
        );
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
            <AiKeyPanel
              variant="inline"
              onVerified={() => {
                setHasApiKey(true);
                onApiKeyVerified?.();
              }}
            />
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
                Drop in notes about one person or many — text, voice, photos,
                calendar invites, or email forwards. Orbit splits profiles out,
                keeps shared event/group context attached to each, and you
                review one card at a time.
              </p>
            )}
            {compact && (
              <p className="mt-1 text-xs text-muted-foreground">
                Multi-person notes (text / voice / photo / .ics / .eml) →
                extract → review → save.
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
              multiple
              accept={CAPTURE_FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              disabled={pending}
              onClick={() => fileRef.current?.click()}
            >
              Upload notes / media
            </Button>
            {fileName && (
              <span className="truncate text-xs text-muted-foreground">
                {fileName}
              </span>
            )}
            {ingestSources.length > 0 && (
              <span className="truncate text-xs text-muted-foreground">
                via {ingestSources.join(", ")}
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
                  const hints: CaptureParseHints | null =
                    lockedParticipantId && lockedParticipantName
                      ? withLockedSeedPerson(captureHints, lockedParticipantName)
                      : captureHints;
                  const res = await parseBulkCaptureNotes(notes, hints);
                  if (!res.ok) {
                    const missingKey = isMissingAiApiKeyError(res.error);
                    if (missingKey) setHasApiKey(false);
                    toast.error(
                      missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error
                    );
                    return;
                  }
                  setSharedNotes(res.sharedNotes || []);
                  const lockedKey =
                    lockedParticipantId && lockedParticipantName
                      ? pickLockedParticipant(
                          res.items.map((item) => ({
                            key: item.key,
                            name: item.parsed.name,
                            duplicateIds: item.duplicates.map((d) => d.id),
                          })),
                          { id: lockedParticipantId, name: lockedParticipantName }
                        )
                      : null;
                  setItems(
                    res.items.map((item) => {
                      const isLocked = lockedKey !== null && item.key === lockedKey;
                      const preferredMatch =
                        preferredContactId &&
                        item.duplicates.some((d) => d.id === preferredContactId)
                          ? preferredContactId
                          : null;
                      return {
                        ...item,
                        decision: "pending" as const,
                        mergeContactId: isLocked
                          ? lockedParticipantId
                          : preferredMatch || item.suggestedMergeId,
                        locked: isLocked,
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
                  const found = res.suggestedReminders || [];
                  setSourceText(res.sourceText);
                  setSourceHash(res.sourceHash);
                  setAnchorIso(res.anchorIso);
                  setAnchorBasis(res.anchorBasis);
                  setSkipped(res.suggestionsSkipped || null);
                  setMentions(res.mentions || []);
                  setSuggestions(
                    found.map((s) => ({
                      ...s,
                      // High-confidence items start checked; the user still sees
                      // every one before anything is written.
                      checked: s.confidenceScore >= 60,
                      personNameOverride: null,
                    }))
                  );
                  setReviewIndex(0);
                  setSlideDirection(1);
                  // A note can carry dates but no people — skip the person carousel.
                  setStep(res.items.length ? "review" : "done");

                  const peopleLabel = `${res.items.length} ${
                    res.items.length === 1 ? "person" : "people"
                  }`;
                  const dateLabel = found.length
                    ? `, ${found.length} ${found.length === 1 ? "date" : "dates"}`
                    : "";
                  toast.success(`Found ${peopleLabel}${dateLabel}`);
                } catch (err) {
                  const message = toUserFacingError(
                    err,
                    MISSING_AI_API_KEY_MESSAGE
                  ).message;
                  if (isMissingAiApiKeyError(message)) setHasApiKey(false);
                  toast.error(message);
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
                  "font-medium text-ink",
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
              <p className="text-xs font-medium text-ink">
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
                initial={{
                  opacity: 0,
                  x: slideDirection * 48,
                  rotate: slideDirection * 1.5,
                }}
                animate={{ opacity: 1, x: 0, rotate: 0 }}
                exit={{
                  opacity: 0,
                  x: slideDirection * -56,
                  rotate: slideDirection * -2,
                }}
                transition={{ duration: DUR.base, ease: EASE_HOUSE }}
              >
                <PersonReviewCard
                  item={current}
                  compact={compact}
                  preferredContactId={preferredContactId}
                  preferredContactName={preferredContactName}
                  lockedParticipantName={lockedParticipantName}
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
                  "font-medium text-ink",
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
          ) : suggestions.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              No people to save from these notes — just the dates below.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              You discarded everyone. Go back to review again, or start over.
            </p>
          )}

          {(() => {
            const itemCount = accepted.reduce((n, i) => n + i.parsed.action_items.length, 0);
            if (itemCount === 0) return null;
            const dueLabel = anchorIso
              ? format(addDays(new Date(`${anchorIso}T12:00:00`), 14), "MMM d")
              : "in 2 weeks";
            return (
              <p className="text-xs text-muted-foreground">
                {itemCount} action item{itemCount === 1 ? "" : "s"} will also become reminders due {dueLabel}
              </p>
            );
          })()}

          {mentions.length > 0 && (
            <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs">
              <p className="mb-1 font-medium">Mentioned, not met</p>
              <ul className="space-y-0.5">
                {mentions.map((m) => (
                  <li key={m.text}>
                    “{m.text}” {m.contactId ? <>→ linked to an existing contact ({Math.round(m.confidence * 100)}%)</> : <span className="text-muted-foreground">— no match; you can add them after saving</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <SuggestedRemindersReview
            items={suggestions}
            people={accepted.map((item) => ({
              key: item.key,
              name: item.parsed.name || "Unnamed",
            }))}
            onChange={setSuggestions}
            skipped={skipped}
          />

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
              disabled={pending || (accepted.length === 0 && checkedDates === 0)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 sm:flex-1"
              onClick={saveAccepted}
            >
              {pending ? "Saving…" : saveLabel}
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
