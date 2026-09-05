"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";
import { confirmBulkCapture, parseBulkCaptureNotes } from "@/actions/capture";
import { logInteraction } from "@/actions/contacts";
import { undoNoteBatch } from "@/actions/note-batches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  INTERACTION_TYPES,
  type InteractionTypeValue,
} from "@/lib/interaction-types";
import { pickLockedParticipant, withLockedSeedPerson } from "@/lib/note-batches";
import { isMissingAiApiKeyError } from "@/lib/errors";
import { cn } from "@/lib/utils";

function todayYmd() {
  return format(new Date(), "yyyy-MM-dd");
}

function yesterdayYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return format(d, "yyyy-MM-dd");
}

/**
 * The profile's single logging entry point.
 *
 * It replaces two half-answers: the old timeline "Add" form, which let you set a type and date
 * but never ran extraction, and the "Add notes" card, which extracted everything but hard-coded
 * the type to `meeting_note` and the date to whatever the note said. Here the user picks the
 * type and date, writes freely, and the existing capture pipeline fills in the summary, action
 * items, mentions and dated reminders.
 *
 * There is deliberately no review step — the user chose speed over a preview — so the batch
 * Undo in the success toast is the safety net. Everything one save creates belongs to one
 * `note_batches` row, and `undoNoteBatch` reverses it.
 */
export function LogInteractionSheet({
  contactId,
  contactName,
  hasApiKey,
  open,
  onOpenChange,
}: {
  contactId: string;
  contactName: string;
  hasApiKey: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [stage, setStage] = useState<"idle" | "reading" | "saving">("idle");
  const [type, setType] = useState<InteractionTypeValue>("meeting");
  const [date, setDate] = useState(todayYmd);
  const [notes, setNotes] = useState("");

  function reset() {
    setType("meeting");
    setDate(todayYmd());
    setNotes("");
    setStage("idle");
  }

  /** No AI key, or extraction could not attribute the note — never lose what was typed. */
  async function savePlain(reason?: string) {
    setStage("saving");
    await logInteraction({
      contactId,
      interactionType: type,
      interactionDate: date || undefined,
      rawNotes: notes.trim(),
      // Deliberately no `aiSummary`: nothing summarized this. Every reader already falls
      // back to `rawNotes`, so faking one would only make an unsummarized note look
      // summarized.
      parseDateFromNotes: !date,
    });
    toast.success(reason ? `Logged — ${reason}` : "Interaction logged");
    onOpenChange(false);
    reset();
    router.refresh();
  }

  function save() {
    const text = notes.trim();
    if (!text) return;

    start(async () => {
      try {
        if (!hasApiKey) {
          await savePlain("add an AI key in Settings to pull out summaries");
          return;
        }

        setStage("reading");
        const res = await parseBulkCaptureNotes(
          text,
          withLockedSeedPerson(
            { eventDate: date || null, interactionType: type },
            contactName
          )
        );

        if (!res.ok) {
          // A missing key is a configuration fact, not a failed save; anything else is a
          // genuine extraction failure. Either way the note itself still gets logged.
          await savePlain(
            isMissingAiApiKeyError(res.error)
              ? "no AI key, so it was saved as written"
              : "couldn't summarize it, so it was saved as written"
          );
          return;
        }

        const lockedKey = pickLockedParticipant(
          res.items.map((item) => ({
            key: item.key,
            name: item.parsed.name,
            duplicateIds: item.duplicates.map((d) => d.id),
          })),
          { id: contactId, name: contactName }
        );
        const locked = res.items.find((item) => item.key === lockedKey);

        if (!locked) {
          await savePlain("couldn't tell which notes were about them");
          return;
        }

        setStage("saving");
        // Only the locked person is saved. Other people the note names are not silently
        // turned into contacts here — that review belongs to /capture — but they still
        // become mentions when they match someone already in the orbit.
        const others = res.items.length - 1;
        const out = await confirmBulkCapture(
          [
            {
              notes: locked.notes,
              parsed: locked.parsed,
              mergeContactId: contactId,
              createReminder: Boolean(locked.parsed.follow_up_recommendation),
              relationshipScore: locked.parsed.relationship_score_suggestion || 2,
              tagNames: locked.parsed.tags || [],
              followUpDays: locked.parsed.follow_up_days || 14,
              interactionDate: date || locked.interactionDate,
              interactionType: type,
            },
          ],
          {
            sourceHash: res.sourceHash,
            sourceText: res.sourceText,
            anchorIso: date || res.anchorIso,
            anchorBasis: date ? "hint" : res.anchorBasis,
            entryPoint: "profile",
            seedContactId: contactId,
            commitments: (res.suggestedReminders || []).map((s) => ({
              title: s.title,
              description: s.description,
              rawDatePhrase: s.rawDatePhrase,
              dueDateIso: s.dueDateIso,
              yearInferred: s.yearInferred,
              personName: s.personName,
              actionKind: s.actionKind,
              confidenceScore: s.confidenceScore,
              sourceExcerpt: s.sourceExcerpt,
              dateBasis: s.dateBasis,
              anchorIso: s.anchorIso,
            })),
            mentions: res.mentions || [],
            skipped: res.suggestionsSkipped ?? {
              relative: 0,
              unverifiable: 0,
              past: 0,
            },
          }
        );

        onOpenChange(false);
        reset();
        router.refresh();

        const batchId = out.batchId;
        toast.success(
          out.remindersCreated > 0
            ? `Logged — ${out.remindersCreated} reminder${out.remindersCreated === 1 ? "" : "s"} set`
            : "Logged and summarized",
          {
            action: {
              label: "Undo",
              onClick: () => {
                void undoNoteBatch(batchId)
                  .then(() => {
                    toast.success("Undone");
                    router.refresh();
                  })
                  .catch(() => toast.error("Could not undo"));
              },
            },
          }
        );

        if (others > 0) {
          toast.info(
            `${others} other ${others === 1 ? "person was" : "people were"} named — add them in Capture`
          );
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not log interaction"
        );
      } finally {
        setStage("idle");
      }
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <SheetContent className="flex flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Log an interaction</SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <Label>What happened</Label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {INTERACTION_TYPES.map((t) => {
                const Icon = t.icon;
                const selected = t.value === type;
                return (
                  <button
                    key={t.value}
                    type="button"
                    title={t.hint}
                    aria-pressed={selected}
                    onClick={() => setType(t.value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-left text-xs transition-colors",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                      selected
                        ? "border-primary/60 bg-primary/10 text-ink"
                        : "border-border/60 text-muted-foreground hover:border-border hover:text-ink"
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{t.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="log-interaction-date">When</Label>
            <div className="flex items-center gap-2">
              <Input
                id="log-interaction-date"
                type="date"
                className="flex-1"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => setDate(todayYmd())}
              >
                Today
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => setDate(yesterdayYmd())}
              >
                Yesterday
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="log-interaction-notes">Notes</Label>
            <Textarea
              id="log-interaction-notes"
              rows={9}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={`What did you talk about with ${contactName}? What did you learn, and what did you say you'd do next?`}
            />
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <Sparkles className="mt-px size-3 shrink-0" />
              {hasApiKey
                ? "Write it however you like — the summary, action items and any dates get pulled out for you."
                : "Saved as written. Add an AI key in Settings to get summaries and action items."}
            </p>
          </div>

          <Button
            type="button"
            className="w-full"
            disabled={pending || !notes.trim()}
            onClick={save}
          >
            {stage === "reading"
              ? "Reading your notes…"
              : stage === "saving"
                ? "Saving…"
                : "Log interaction"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
