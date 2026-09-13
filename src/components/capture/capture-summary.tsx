"use client";

/**
 * After the last card: everyone you kept, one row each with Edit, the dated commitments
 * the notes carried, and one Save. Skipped and set-aside people are counted, not listed —
 * they are in Ignored people at the bottom of the page.
 */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { addDays, format } from "date-fns";
import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PersonEditDialog } from "@/components/capture/person-edit-dialog";
import { PlanetBadge } from "@/components/capture/review/planet-badge";
import { decisionFromDraft, draftFromItem } from "@/components/capture/review/person-deck";
import type { PersonDraft } from "@/components/capture/review/person-card";
import { SuggestedRemindersReview } from "@/components/capture/suggested-reminders-review";
import type { SuggestionReviewItem } from "@/components/chat/bulk-notes-panel";
import { acceptedPeople, countDecisions, defaultReminderKeys, peopleDecisions } from "@/lib/capture/review-reducer";
import type { CaptureDecision, CaptureDecisions, CaptureJobResult, CaptureReminderChoices } from "@/lib/capture/types";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";

export function suggestionsFromChoices(result: CaptureJobResult, choices: CaptureReminderChoices | undefined): SuggestionReviewItem[] {
  const checked = new Set(choices?.checked ?? defaultReminderKeys(result.suggestedReminders));
  return result.suggestedReminders.map((s) => {
    const o = choices?.overrides?.[s.key];
    return {
      ...s,
      dueDateIso: o?.dueDateIso ?? s.dueDateIso,
      checked: checked.has(s.key),
      personNameOverride: o?.personName === undefined ? null : o.personName,
    };
  });
}

export function choicesFromSuggestions(items: SuggestionReviewItem[], base: readonly { key: string; dueDateIso: string }[]): CaptureReminderChoices {
  const overrides: CaptureReminderChoices["overrides"] = {};
  for (const it of items) {
    const original = base.find((b) => b.key === it.key);
    const o: { personName?: string | null; dueDateIso?: string } = {};
    if (it.personNameOverride !== null) o.personName = it.personNameOverride;
    if (original && it.dueDateIso !== original.dueDateIso) o.dueDateIso = it.dueDateIso;
    if (Object.keys(o).length) overrides[it.key] = o;
  }
  return { checked: items.filter((i) => i.checked).map((i) => i.key), overrides };
}

export function CaptureSummary({
  result,
  decisions,
  suggestions,
  onSuggestionsChange,
  onDecide,
  onSave,
  onStartOver,
  onBack,
  saving,
  error,
  lockedName,
  headerSlot,
  hasMeeting = false,
  meetingExtraCount = 0,
}: {
  result: CaptureJobResult;
  decisions: CaptureDecisions;
  suggestions: SuggestionReviewItem[];
  onSuggestionsChange: (next: SuggestionReviewItem[]) => void;
  onDecide: (key: string, decision: CaptureDecision) => void;
  onSave: () => void;
  onStartOver: () => void;
  onBack: () => void;
  saving: boolean;
  error?: string | null;
  lockedName?: string | null;
  headerSlot?: React.ReactNode;
  hasMeeting?: boolean;
  meetingExtraCount?: number;
}) {
  const people = peopleDecisions(decisions);
  const accepted = acceptedPeople(result.items, decisions);
  const counts = countDecisions(result.items, decisions);
  const [editing, setEditing] = useState<string | null>(null);
  const checkedDates = suggestions.filter((s) => s.checked).length;

  const saveLabel = useMemo(() => {
    const parts: string[] = [];
    if (hasMeeting) parts.push("meeting");
    if (accepted.length) parts.push(`${accepted.length} ${accepted.length === 1 ? "contact" : "contacts"}`);
    const reminderCount = checkedDates + meetingExtraCount;
    if (reminderCount) parts.push(`${reminderCount} ${reminderCount === 1 ? "reminder" : "reminders"}`);
    return parts.length ? `Save ${parts.join(" + ")}` : "Save";
  }, [accepted.length, checkedDates, hasMeeting, meetingExtraCount]);

  const actionItemCount = accepted.reduce((n, a) => n + a.item.parsed.action_items.length, 0);
  const dueLabel = result.anchorIso ? format(addDays(new Date(`${result.anchorIso}T12:00:00`), 14), "MMM d") : "in 2 weeks";
  const editingEntry = editing ? accepted.find((a) => a.item.key === editing) ?? null : null;
  const canSave = hasMeeting || accepted.length > 0 || checkedDates > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: DUR.base, ease: EASE_HOUSE }}
      className="space-y-5"
    >
      {headerSlot}
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-2xl text-ink">Ready to save</h2>
            <p className="text-sm text-muted-foreground">
              {counts.accepted} kept
              {counts.skipped ? ` · ${counts.skipped} for later` : ""}
              {counts.rejected ? ` · ${counts.rejected} set aside` : ""}
              {counts.skipped + counts.rejected > 0 ? " — they’re in Ignored people below" : ""}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack} disabled={saving}>
            Back to the cards
          </Button>
        </div>

        {accepted.length > 0 ? (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {accepted.map(({ item, decision, index }) => {
                const draft = draftFromItem(item, decision);
                const name = draft.fields.name.trim() || "Unnamed person";
                const sub = [draft.fields.company.trim(), draft.fields.role.trim()].filter(Boolean).join(" · ");
                return (
                  <motion.li
                    key={item.key}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={SPRING_PILL}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2"
                  >
                    <PlanetBadge index={index} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{name}</p>
                      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
                    </div>
                    <Badge variant={draft.mergeContactId ? "secondary" : "outline"} className="text-[10px]">
                      {draft.mergeContactId ? "Update" : "New"}
                    </Badge>
                    <Button variant="outline" size="sm" onClick={() => setEditing(item.key)} disabled={saving}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Set ${name} aside`}
                      className="text-muted-foreground"
                      disabled={saving}
                      onClick={() => onDecide(item.key, decisionFromDraft("reject", index, draft))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        ) : hasMeeting ? (
          <p className="text-sm text-muted-foreground">
            No people to save from this meeting — its summary{checkedDates + meetingExtraCount > 0 ? " and reminders" : ""} will still be saved.
          </p>
        ) : suggestions.length > 0 ? (
          <p className="text-sm text-muted-foreground">No people to save from these notes — just the dates below.</p>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody kept. Go back to the cards, or start over.</p>
        )}

        {actionItemCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {actionItemCount} action item{actionItemCount === 1 ? "" : "s"} will also become reminders due {dueLabel}. Follow-ups are timed by how close you said you are.
          </p>
        )}

        <SuggestedRemindersReview
          items={suggestions}
          people={accepted.map(({ item, decision }) => ({ key: item.key, name: decision.edits?.name || item.parsed.name || "Unnamed" }))}
          onChange={onSuggestionsChange}
          skipped={result.suggestionsSkipped}
        />

        {error && (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/[0.04] px-3 py-2 text-sm text-foreground">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onStartOver} disabled={saving}>
            Start over
          </Button>
          <Button
            type="button"
            disabled={saving || !canSave}
            className="bg-primary text-primary-foreground hover:bg-primary/90 sm:flex-1"
            onClick={onSave}
          >
            {saving ? "Saving…" : error ? "Try again" : saveLabel}
          </Button>
        </div>
      </div>

      {editingEntry && (
        <PersonEditDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          item={editingEntry.item}
          index={editingEntry.index}
          draft={draftFromItem(editingEntry.item, people[editingEntry.item.key])}
          lockedName={lockedName}
          onDone={(next: PersonDraft) => onDecide(editingEntry.item.key, decisionFromDraft("accept", editingEntry.index, next))}
        />
      )}
    </motion.div>
  );
}
