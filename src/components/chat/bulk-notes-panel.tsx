"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { toast } from "@/lib/toast";
import {
  confirmBulkCapture,
  ingestCaptureMedia,
  parseBulkCaptureNotes,
} from "@/actions/capture";
import { getSettings } from "@/actions/settings";
import type { CaptureParseHints, SharedNoteContext } from "@/lib/ai";
import {
  MISSING_AI_API_KEY_MESSAGE,
  isMissingAiApiKeyError,
  toUserFacingError,
} from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  CaptureSwipeCard,
  type CaptureReviewItem,
  type SwipeDecision,
} from "@/components/capture/capture-swipe-card";
import {
  clearCaptureNotesDraft,
  loadCaptureNotesDraft,
  saveCaptureNotesDraft,
} from "@/lib/capture-draft";
import { cn } from "@/lib/utils";

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

const PARSE_STAGES = [
  { label: "Preparing notes", until: 18 },
  { label: "Finding people", until: 42 },
  { label: "Extracting conversations", until: 72 },
  { label: "Matching contacts", until: 90 },
] as const;

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

function stageLabelForProgress(value: number) {
  for (const stage of PARSE_STAGES) {
    if (value < stage.until) return stage.label;
  }
  return PARSE_STAGES[PARSE_STAGES.length - 1]!.label;
}

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
  const [captureHints, setCaptureHints] = useState<CaptureParseHints | null>(
    null
  );
  const [ingestSources, setIngestSources] = useState<string[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const [step, setStep] = useState<"paste" | "review" | "done">("paste");
  const [items, setItems] = useState<CaptureReviewItem[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteContext[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [hasApiKeyFetched, setHasApiKeyFetched] = useState(true);
  const hasApiKey = hasApiKeyProp ?? hasApiKeyFetched;
  const [pending, start] = useTransition();
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [exiting, setExiting] = useState<SwipeDecision | null>(null);
  const [exitDirection, setExitDirection] = useState<1 | -1>(1);
  const parseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (hasApiKeyProp !== undefined) return;
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setHasApiKeyFetched(settings.hasApiKey);
      })
      .catch(() => {
        // Keep extract enabled; the action returns a clear error if needed.
      });
    return () => {
      cancelled = true;
    };
  }, [hasApiKeyProp]);

  useEffect(() => {
    let cancelled = false;
    // Defer so hydration isn't a sync setState-in-effect (SSR-safe restore).
    queueMicrotask(() => {
      if (cancelled) return;
      const draft = loadCaptureNotesDraft();
      if (draft?.notes.trim()) {
        setNotes(draft.notes);
        setFileName(draft.fileName);
        setCaptureHints(draft.hints);
        setIngestSources(draft.ingestSources);
      }
      setDraftReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    const handle = window.setTimeout(() => {
      saveCaptureNotesDraft({
        notes,
        fileName,
        ingestSources,
        hints: captureHints,
      });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [draftReady, notes, fileName, ingestSources, captureHints]);

  useEffect(() => {
    return () => {
      if (parseTimerRef.current) clearInterval(parseTimerRef.current);
    };
  }, []);

  const accepted = items.filter((i) => i.decision === "accepted");
  const discarded = items.filter((i) => i.decision === "discarded");
  const current = items[reviewIndex] ?? null;
  const isLastCard = reviewIndex >= items.length - 1 && items.length > 0;

  function clearParseProgress() {
    if (parseTimerRef.current) {
      clearInterval(parseTimerRef.current);
      parseTimerRef.current = null;
    }
    setParsing(false);
    setParseProgress(0);
  }

  function beginParseProgress() {
    setParsing(true);
    setParseProgress(4);
    if (parseTimerRef.current) clearInterval(parseTimerRef.current);
    parseTimerRef.current = setInterval(() => {
      setParseProgress((prev) => {
        if (prev >= 90) return prev;
        const remaining = 90 - prev;
        const stepAmt = Math.max(0.6, remaining * 0.045);
        return Math.min(90, prev + stepAmt);
      });
    }, 280);
  }

  function finishParseProgress() {
    if (parseTimerRef.current) {
      clearInterval(parseTimerRef.current);
      parseTimerRef.current = null;
    }
    setParseProgress(100);
  }

  function resetToPaste() {
    setStep("paste");
    setNotes("");
    setFileName(null);
    setCaptureHints(null);
    setIngestSources([]);
    setItems([]);
    setSharedNotes([]);
    setReviewIndex(0);
    setExiting(null);
    clearParseProgress();
    clearCaptureNotesDraft();
  }

  function applyDecision(decision: SwipeDecision) {
    const index = reviewIndex;
    const last = index >= items.length - 1;
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, decision } : item))
    );
    setExiting(null);
    if (last) {
      setStep("done");
    } else {
      setReviewIndex(index + 1);
    }
  }

  function commitDecision(decision: SwipeDecision) {
    if (!current || exiting) return;
    if (decision === "accepted" && !current.parsed.name?.trim()) {
      toast.error("Add a name before accepting");
      return;
    }
    if (reduceMotion) {
      applyDecision(decision);
      return;
    }
    setExitDirection(decision === "accepted" ? 1 : -1);
    setExiting(decision);
  }

  function goBack() {
    if (exiting) return;
    if (reviewIndex <= 0) {
      setStep("paste");
      return;
    }
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
        if (!payload.length) {
          toast.error("No contacts to save — accept at least one person");
          return;
        }
        const res = await confirmBulkCapture(payload);
        toast.success(
          `Saved: ${res.created} created, ${res.updated} updated`
        );
        clearCaptureNotesDraft();
        setNotes("");
        setFileName(null);
        setCaptureHints(null);
        setIngestSources([]);
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
          if (missingKey) setHasApiKeyFetched(false);
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

  function extractPeople() {
    beginParseProgress();
    start(async () => {
      try {
        const res = await parseBulkCaptureNotes(notes, captureHints);
        if (!res.ok) {
          clearParseProgress();
          const missingKey = isMissingAiApiKeyError(res.error);
          if (missingKey) setHasApiKeyFetched(false);
          toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error);
          return;
        }
        finishParseProgress();
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
              mergeContactId: preferredMatch || item.suggestedMergeId,
              createReminder: Boolean(item.parsed.follow_up_recommendation),
              relationshipScore:
                item.parsed.relationship_score_suggestion || 2,
              tagNames: (item.parsed.tags || []).join(", "),
              followUpDays: item.parsed.follow_up_days || 14,
            };
          })
        );
        setReviewIndex(0);
        setExiting(null);
        window.setTimeout(() => {
          clearParseProgress();
          setStep("review");
          toast.success(
            `Found ${res.items.length} ${res.items.length === 1 ? "person" : "people"}`
          );
        }, 220);
      } catch (err) {
        clearParseProgress();
        const message = toUserFacingError(
          err,
          MISSING_AI_API_KEY_MESSAGE
        ).message;
        if (isMissingAiApiKeyError(message)) setHasApiKeyFetched(false);
        toast.error(message);
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
              disabled={parsing}
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
              disabled={pending || parsing}
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

          {parsing ? (
            <div
              className="space-y-2 rounded-xl border border-border/70 bg-muted/30 p-3"
              aria-live="polite"
            >
              <div className="flex items-center justify-between gap-2 text-sm">
                <p className="font-medium text-foreground">
                  {stageLabelForProgress(parseProgress)}
                </p>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {Math.round(parseProgress)}%
                </span>
              </div>
              <Progress value={parseProgress} aria-label="Extracting people" />
              <p className="text-xs text-muted-foreground">
                Pulling people and conversation context from your notes…
              </p>
            </div>
          ) : (
            <Button
              disabled={pending || !notes.trim() || !hasApiKey}
              size={compact ? "sm" : "default"}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
              onClick={extractPeople}
            >
              Extract people
            </Button>
          )}
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
                Swipe right to accept, left to discard — or use the buttons.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={Boolean(exiting)}
              onClick={goBack}
            >
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

          <div className="relative overflow-hidden px-0.5 py-1">
            <CaptureSwipeCard
              key={current.key}
              item={current}
              compact={compact}
              preferredContactId={preferredContactId}
              preferredContactName={preferredContactName}
              reduceMotion={reduceMotion}
              exiting={exiting}
              exitDirection={exitDirection}
              disabled={Boolean(exiting)}
              onChange={(next) =>
                setItems((prev) =>
                  prev.map((p, i) => (i === reviewIndex ? next : p))
                )
              }
              onSwipeCommit={commitDecision}
              onExitComplete={() => {
                if (exiting) applyDecision(exiting);
              }}
            />
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
              disabled={pending || Boolean(exiting)}
              onClick={() => commitDecision("discarded")}
            >
              Discard
            </Button>
            <Button
              type="button"
              size={compact ? "sm" : "default"}
              disabled={
                pending ||
                Boolean(exiting) ||
                !current.parsed.name?.trim()
              }
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => commitDecision("accepted")}
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
                setReviewIndex(Math.max(0, items.length - 1));
                setItems((prev) =>
                  prev.map((item, i) =>
                    i === items.length - 1
                      ? { ...item, decision: "pending" }
                      : item
                  )
                );
                setExiting(null);
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
