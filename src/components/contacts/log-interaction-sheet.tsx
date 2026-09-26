"use client";

import { useRef, useState, useTransition } from "react";
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
import {
  FIELD_BARE,
  FIELD_SHELL,
  MentionComposer,
} from "@/components/composer/mention-composer";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SELECTABLE_INTERACTION_TYPES,
  interactionFamilySpec,
  type InteractionTypeValue,
} from "@/lib/interaction-types";
import { requestInteractionFlight } from "@/components/contacts/interaction-flight";
import { pickLockedParticipant, withLockedSeedPerson } from "@/lib/note-batches";
import { activePicks, type MentionPick } from "@/lib/mentions/mention-picks";
import { friendlyError, isMissingAiApiKeyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { TOAST_COPY } from "@/lib/toast-copy";
import { AI_HINT_COPY, aiDenialFromMessage } from "@/lib/ai-access-copy";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

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
/** Why a note was saved without a summary, completing "…, so it was saved as written". */
const PLAIN_SAVE_REASON: Record<AiAccessDenial, string> = {
  key_required: "no AI key",
  managed_limit: "this month’s included AI is used",
  managed_unavailable: "Orbit’s AI is unavailable right now",
  upgrade_pending: "your Lifetime payment is still clearing",
};

export function LogInteractionSheet({
  contactId,
  contactName,
  hasApiKey,
  aiReason = null,
  open,
  onOpenChange,
}: {
  contactId: string;
  contactName: string;
  hasApiKey: boolean;
  /** The AI gate's reason when `hasApiKey` is false — worded into the hint and the toast. */
  aiReason?: AiAccessDenial | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const submitRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  /** The flight's origin, captured while the button still exists. */
  function launchFrom() {
    const r = submitRef.current?.getBoundingClientRect();
    return r
      ? { top: r.top, left: r.left, width: r.width, height: r.height }
      : null;
  }
  const [pending, start] = useTransition();
  const [stage, setStage] = useState<"idle" | "reading" | "saving">("idle");
  const [type, setType] = useState<InteractionTypeValue>("meeting");
  const [date, setDate] = useState(todayYmd);
  const [notes, setNotes] = useState("");
  /**
   * Other people named with `@`.
   *
   * The sheet only ever saves ONE participant — the person whose profile it was opened from
   * — so an `@` here is always somebody else, and always a mention rather than a second
   * contact. That is the same thing extraction already tries to do from the prose, minus
   * the guessing: "caught up with @Ada about it" links to the Ada you pointed at rather than
   * to whichever Ada the name matcher likes.
   */
  const [mentionPicks, setMentionPicks] = useState<MentionPick[]>([]);

  function reset() {
    setType("meeting");
    setDate(todayYmd());
    setNotes("");
    setMentionPicks([]);
    setStage("idle");
  }

  /** No AI key, or extraction could not attribute the note — never lose what was typed. */
  async function savePlain(reason?: string) {
    setStage("saving");
    const from = launchFrom();
    const row = await logInteraction({
      contactId,
      interactionType: type,
      interactionDate: date || undefined,
      rawNotes: notes.trim(),
      // Deliberately no `aiSummary`: nothing summarized this. Every reader already falls
      // back to `rawNotes`, so faking one would only make an unsummarized note look
      // summarized.
      parseDateFromNotes: !date,
    });
    toast.success(reason ? `Logged — ${reason}` : "Logged");
    onOpenChange(false);
    reset();
    router.refresh();
    if (from) {
      requestInteractionFlight({
        from,
        interactionType: type,
        interactionId: row?.id,
      });
    }
  }

  function save() {
    const text = notes.trim();
    if (!text) return;

    start(async () => {
      try {
        if (!hasApiKey) {
          await savePlain(
            aiReason && aiReason !== "key_required"
              ? `${PLAIN_SAVE_REASON[aiReason]}, so it was saved as written`
              : "add an AI key in Settings to pull out summaries"
          );
          return;
        }

        setStage("reading");
        const res = await parseBulkCaptureNotes(
          text,
          withLockedSeedPerson(
            { eventDate: date || null, interactionType: type },
            contactName
          ),
          // Only the picks whose token is still in the box: the list is append-only, so a
          // name typed and then deleted is still in it, and sending that would link the
          // note to somebody the user took back out.
          { mentionPicks: activePicks(text, mentionPicks) }
        );

        if (!res.ok) {
          // A missing key is a configuration fact, not a failed save; anything else is a
          // genuine extraction failure. Either way the note itself still gets logged.
          const denial = aiDenialFromMessage(res.error);
          await savePlain(
            denial
              ? `${PLAIN_SAVE_REASON[denial]}, so it was saved as written`
              : isMissingAiApiKeyError(res.error)
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
                  .catch(() => toast.error(TOAST_COPY.undoFailed));
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
          friendlyError(err, "Couldn’t log that — try again?")
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

        {/* `px-4` matches the header's own inset — without it the fields sat flush against
            the panel edge while the title did not. No `mt`: the sheet's `gap-4` already
            spaces this off the header, and stacking a margin on top of it opened a 40px
            void under the title. */}
        <div className="space-y-5 px-4 pb-4">
          <div className="space-y-2">
            <Label>What happened</Label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {/* The list is already ordered by family, so tinting each icon gives the
                  options a grouping the eye can use without extra headings in an
                  already tall sheet. */}
              {SELECTABLE_INTERACTION_TYPES.map((t) => {
                const Icon = t.icon;
                const fam = interactionFamilySpec(t.value);
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
                        ? fam.chip
                        : "border-border/60 text-muted-foreground hover:border-border hover:text-ink"
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-3.5 shrink-0",
                        selected ? undefined : fam.text
                      )}
                    />
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
            {/* `relative` anchors the `@` menu to this box. Below it: the sheet scrolls, and
                a menu hanging above a nine-row field is the first thing to go off the top. */}
            <div className="relative">
              <MentionComposer
                className={FIELD_SHELL}
                textareaRef={notesRef}
                value={notes}
                onValueChange={setNotes}
                picks={mentionPicks}
                onPicksChange={setMentionPicks}
                menuPlacement="below"
                // The field itself stays editable while a save is in flight, as it always
                // has; only the menu shuts. A pick made now would splice into text the save
                // has already taken a copy of, so the token would appear with nothing behind
                // it.
                menuEnabled={!pending}
                id="log-interaction-notes"
                rows={9}
                placeholder={`What did you talk about with ${contactName}? What did you learn, and what did you say you'd do next?`}
                textareaClassName={FIELD_BARE}
              />
            </div>
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <Sparkles className="mt-px size-3 shrink-0" />
              {hasApiKey
                ? "Write it however you like — the summary, action items and any dates get pulled out for you. Type @ to link someone else who came up."
                : `Saved as written. ${AI_HINT_COPY[aiReason ?? "key_required"]}.`}
            </p>
          </div>

          <Button
            ref={submitRef}
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
