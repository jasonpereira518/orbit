"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays, format } from "date-fns";
import { toast } from "@/lib/toast";
import { confirmBulkCapture, ingestCaptureMedia } from "@/actions/capture";
import { SuggestedRemindersReview } from "@/components/capture/suggested-reminders-review";
import { PersonReviewList } from "@/components/capture/person-review-list";
import {
  CaptureProgress,
  type CaptureProgressState,
} from "@/components/capture/capture-progress";
import { streamCaptureParse } from "@/lib/capture-stream-client";
import type { BulkNotePersonPreview } from "@/lib/capture-preview";
import type {
  ReviewItem,
  SuggestionReviewItem,
} from "@/lib/capture-review-item";
import {
  CAPTURE_MAX_UPLOAD_BYTES,
  formatUploadSize,
} from "@/lib/capture-limits";
import { getSettings } from "@/actions/settings";
import type { SaveNoteBatchOutput } from "@/lib/note-batch-save";
import {
  pickLockedParticipant,
  withLockedSeedPerson,
  type PreviewMention,
} from "@/lib/note-batches";
import type { CaptureParseHints, ParsedNote, SharedNoteContext } from "@/lib/ai";
import {
  MISSING_AI_API_KEY_MESSAGE,
  isMissingAiApiKeyError,
  toUserFacingError,
} from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

/**
 * A fully-formed empty `ParsedNote`, for a roster row whose detail pass has not landed.
 *
 * Spread rather than cast: a partial object asserted as a `ParsedNote` type-checks and then
 * throws on the first `.topics.map` somewhere downstream. Filling the arrays costs nothing
 * and makes a placeholder row safe to read like any other.
 */
const EMPTY_PARSED: ParsedNote = {
  name: null,
  company: null,
  role: null,
  presence: "participant",
  location: null,
  email: null,
  linkedin_url: null,
  met_at: null,
  topics: [],
  action_items: [],
  follow_up_recommendation: null,
  follow_up_days: null,
  relationship_score_suggestion: null,
  tags: [],
  summary: null,
  key_facts: [],
  opportunities: [],
  shared_interests: [],
  suggested_next_message: null,
  confidence: null,
  interaction_date: null,
  low_confidence_fields: [],
};

export function BulkNotesPanel({
  compact = false,
  preferredContactId = null,
  preferredContactName = null,
  lockedParticipantId = null,
  lockedParticipantName = null,
  entryPoint,
  hasApiKey: hasApiKeyProp,
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
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteContext[]>([]);
  /** Which row is open for editing. One at a time keeps the list scannable. */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
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
  /**
   * Extraction state is `useState`, not `useTransition`. A transition's `pending` is a
   * single boolean that ends when the awaited call returns; a stream produces many updates
   * over its lifetime and has to keep rendering them as they land.
   */
  const [progress, setProgress] = useState<CaptureProgressState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  const accepted = items.filter((i) => i.decision === "accepted" && !i.placeholder);
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

  const resetToPaste = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(null);
    setStep("paste");
    setNotes("");
    setFileName(null);
    setCaptureHints(null);
    setIngestSources([]);
    setItems([]);
    setSharedNotes([]);
    setExpandedKey(null);
    setSuggestions([]);
    setSourceText(null);
    setSourceHash(null);
    setAnchorIso(null);
    setAnchorBasis(null);
    setSkipped(null);
    setMentions([]);
  }, []);

  // An extraction abandoned by navigating away should stop costing money server-side.
  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Keyed, not indexed. Rows arrive progressively — a roster row is replaced in place by
   * its detail event — so a row's position is not a stable identity mid-stream.
   */
  const updateItem = useCallback((key: string, next: ReviewItem) => {
    setItems((prev) => prev.map((item) => (item.key === key ? next : item)));
  }, []);

  const setDecision = useCallback((key: string, isAccepted: boolean) => {
    setItems((prev) =>
      prev.map((item) =>
        item.key === key
          ? { ...item, decision: isAccepted ? "accepted" : "discarded" }
          : item
      )
    );
  }, []);

  const setAllDecisions = useCallback((isAccepted: boolean) => {
    setItems((prev) =>
      prev.map((item) =>
        item.placeholder
          ? item
          : { ...item, decision: isAccepted ? "accepted" : "discarded" }
      )
    );
  }, []);

  /**
   * Turn a parsed person into a review row.
   *
   * Rows land `accepted`: the extraction is usually right, and the list's whole point is
   * that the common case is a scan, not N clicks. The merge target is pre-selected the same
   * way it always was — locked participant wins, then the preferred contact, then a
   * duplicate the matcher was confident about.
   */
  const toReviewItem = useCallback(
    (item: BulkNotePersonPreview, lockedKey: string | null): ReviewItem => {
      const isLocked = lockedKey !== null && item.key === lockedKey;
      const preferredMatch =
        preferredContactId &&
        item.duplicates.some((d) => d.id === preferredContactId)
          ? preferredContactId
          : null;
      return {
        ...item,
        decision: "accepted",
        mergeContactId: isLocked
          ? lockedParticipantId
          : preferredMatch || item.suggestedMergeId,
        locked: isLocked,
        createReminder: Boolean(item.parsed.follow_up_recommendation),
        relationshipScore: item.parsed.relationship_score_suggestion || 2,
        tagNames: (item.parsed.tags || []).join(", "),
        followUpDays: item.parsed.follow_up_days || 14,
      };
    },
    [preferredContactId, lockedParticipantId]
  );

  function extract() {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const hints: CaptureParseHints | null =
      lockedParticipantId && lockedParticipantName
        ? withLockedSeedPerson(captureHints, lockedParticipantName)
        : captureHints;

    setItems([]);
    setExpandedKey(null);
    setProgress({ stage: "reading" });

    // The locked participant can only be resolved once every person is known — it picks the
    // best match across the whole set — so rows start unlocked and are re-keyed on `result`.
    let finished = false;
    // Counted here rather than read off state: these callbacks close over the render that
    // created them, so `items` would be the empty list it was when the stream opened.
    const seen = new Set<string>();

    void streamCaptureParse(
      { notes, hints },
      {
        onEvent: (event) => {
          switch (event.type) {
            case "stage":
              setProgress({
                stage: event.stage,
                done: event.done,
                total: event.total,
              });
              break;

            case "roster":
              // Names are known a full detail pass before the details are. Paint the rows
              // now; each fills in when its `person` event lands.
              setItems(
                event.people.map((p) => ({
                  key: p.key,
                  placeholder: true,
                  decision: "pending",
                  notes: "",
                  parsed: {
                    ...EMPTY_PARSED,
                    name: p.name,
                    company: p.company,
                    role: p.role,
                  },
                  duplicates: [],
                  suggestedMergeId: null,
                  sharedNoteTexts: [],
                  interactionDate: null,
                  interactionType: null,
                  mergeContactId: null,
                  createReminder: false,
                  relationshipScore: 2,
                  tagNames: "",
                  followUpDays: 14,
                }))
              );
              setStep("review");
              break;

            case "person": {
              const next = toReviewItem(event.item, null);
              seen.add(next.key);
              setItems((prev) => {
                const at = prev.findIndex((p) => p.key === next.key);
                if (at === -1) return [...prev, next];
                // Replace the skeleton, but keep a decision the user already changed while
                // the details were still in flight.
                const existing = prev[at]!;
                const merged = existing.placeholder
                  ? next
                  : { ...next, decision: existing.decision };
                return prev.map((p, i) => (i === at ? merged : p));
              });
              setStep("review");
              break;
            }

            case "result": {
              finished = true;
              const r = event.result;
              setSharedNotes(r.sharedNotes || []);
              setSourceText(r.sourceText);
              setSourceHash(r.sourceHash);
              setAnchorIso(r.anchorIso);
              setAnchorBasis(r.anchorBasis);
              setSkipped(r.suggestionsSkipped || null);
              setMentions(r.mentions || []);
              const found = r.suggestedReminders || [];
              setSuggestions(
                found.map((sug) => ({
                  ...sug,
                  // High-confidence items start checked; the user still sees
                  // every one before anything is written.
                  checked: sug.confidenceScore >= 60,
                  personNameOverride: null,
                }))
              );
              setItems((prev) => {
                // Drop any skeleton the details never reached, and settle the lock now that
                // the full set is known.
                const real = prev.filter((p) => !p.placeholder);
                const lockedKey =
                  lockedParticipantId && lockedParticipantName
                    ? pickLockedParticipant(
                        real.map((item) => ({
                          key: item.key,
                          name: item.parsed.name,
                          duplicateIds: item.duplicates.map((d) => d.id),
                        })),
                        { id: lockedParticipantId, name: lockedParticipantName }
                      )
                    : null;
                if (!lockedKey) return real;
                return real.map((item) =>
                  item.key === lockedKey
                    ? { ...item, locked: true, mergeContactId: lockedParticipantId }
                    : item
                );
              });
              setProgress(null);
              setStep("review");

              const peopleCount = seen.size;
              const peopleLabel = `${peopleCount} ${
                peopleCount === 1 ? "person" : "people"
              }`;
              const dateLabel = found.length
                ? `, ${found.length} ${found.length === 1 ? "date" : "dates"}`
                : "";
              toast.success(`Found ${peopleLabel}${dateLabel}`);
              break;
            }

            case "error": {
              finished = true;
              const missingKey = isMissingAiApiKeyError(event.message);
              if (missingKey) setHasApiKey(false);
              toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : event.message);
              setProgress(null);
              setItems([]);
              setStep("paste");
              break;
            }
          }
        },
        onError: (message) => {
          finished = true;
          const missingKey = isMissingAiApiKeyError(message);
          if (missingKey) setHasApiKey(false);
          toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : message);
          setProgress(null);
          setItems([]);
          setStep("paste");
        },
      },
      controller.signal
    ).finally(() => {
      if (abortRef.current === controller) abortRef.current = null;
      // A stream that ended without a terminal event is already reported by the client;
      // this only clears the spinner so the button comes back.
      if (!finished) setProgress(null);
    });
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

    // REJECT BEFORE ENCODING, because the failure downstream is invisible. An oversized
    // body is not refused by the server: Next buffers the first N bytes, warns in the
    // server log, and hands the action a truncated payload — which surfaces to the user
    // as a confusing parse failure long after the upload appeared to succeed. Raising the
    // limit only moves that cliff, so the size has to be checked here, where we can still
    // say something true about which files are too big.
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > CAPTURE_MAX_UPLOAD_BYTES) {
      toast.error(
        files.length === 1
          ? `${files[0]!.name} is ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)} per upload.`
          : `Those ${files.length} files total ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)} per upload. Try adding them in smaller batches.`
      );
      return;
    }

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
            disabled={pending || Boolean(progress) || !notes.trim() || !hasApiKey}
            size={compact ? "sm" : "default"}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
            onClick={extract}
          >
            Extract people
          </Button>

          {progress && (
            <CaptureProgress
              state={progress}
              compact={compact}
              onCancel={() => {
                abortRef.current?.abort();
                abortRef.current = null;
                setProgress(null);
                setItems([]);
                setExpandedKey(null);
              }}
            />
          )}
        </div>
      )}

      {step === "review" && (
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
                {progress ? "Finding people" : "Review and save"}
              </h2>
              <p className="text-xs text-muted-foreground">
                Everyone is selected. Uncheck anyone you don&apos;t want, and
                open a row to edit before saving.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={resetToPaste}>
              Start over
            </Button>
          </div>

          {progress && <CaptureProgress state={progress} compact={compact} />}

          {sharedNotes.length > 0 && (
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

          {items.length > 0 ? (
            <PersonReviewList
              items={items}
              expandedKey={expandedKey}
              onExpandedKeyChange={setExpandedKey}
              onItemChange={updateItem}
              onDecisionChange={setDecision}
              onSelectAll={setAllDecisions}
              compact={compact}
              preferredContactId={preferredContactId}
              preferredContactName={preferredContactName}
              lockedParticipantName={lockedParticipantName}
            />
          ) : progress ? null : suggestions.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              No people to save from these notes — just the dates below.
            </p>
          ) : null}

          {(() => {
            const itemCount = accepted.reduce(
              (n, i) => n + (i.parsed.action_items?.length || 0),
              0
            );
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

          {suggestions.length > 0 && (
            <SuggestedRemindersReview
              items={suggestions}
              people={accepted.map((item) => ({
                key: item.key,
                name: item.parsed.name || "Unnamed",
              }))}
              onChange={setSuggestions}
              skipped={skipped}
            />
          )}

          <div
            className={cn(
              "flex flex-col gap-2 sm:flex-row",
              compact &&
                "sticky bottom-0 -mx-1 border-t border-border/60 bg-card px-1 pt-3"
            )}
          >
            <Button
              type="button"
              size={compact ? "sm" : "default"}
              disabled={
                pending ||
                Boolean(progress) ||
                (accepted.length === 0 && checkedDates === 0)
              }
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
