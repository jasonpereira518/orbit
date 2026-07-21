"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowDown,
  ArrowUp,
  FileText,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  logInteraction,
  reorderSameDayInteractions,
  updateInteraction,
} from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type TimelineInteraction = {
  id: string;
  interactionType: string;
  interactionDate: Date | string;
  sameDayOrder?: number | null;
  rawNotes: string | null;
  aiSummary: string | null;
  actionItems: string[] | null;
};

const TYPES = [
  { value: "note", label: "Note" },
  { value: "meeting", label: "Meeting" },
  { value: "reach_out", label: "Reach out" },
  { value: "in_person", label: "In person" },
  { value: "email", label: "Email" },
  { value: "linkedin_message", label: "LinkedIn" },
  { value: "call", label: "Call" },
] as const;

function dayKey(d: Date | string) {
  return format(new Date(d), "yyyy-MM-dd");
}

function typeLabel(type: string) {
  return TYPES.find((t) => t.value === type)?.label || type.replace(/_/g, " ");
}

function oneLine(i: TimelineInteraction) {
  const text = (i.aiSummary || i.rawNotes || "").trim();
  if (!text) return "Interaction logged";
  const line = text.split(/\n/)[0]?.trim() || text;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

export function ContactTimeline({
  contactId,
  interactions,
}: {
  contactId: string;
  interactions: TimelineInteraction[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notesOpen, setNotesOpen] = useState<TimelineInteraction | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TimelineInteraction | null>(null);
  const [formType, setFormType] = useState("note");
  const [formDate, setFormDate] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formActions, setFormActions] = useState("");

  const sorted = useMemo(() => {
    return [...interactions].sort((a, b) => {
      const da = new Date(a.interactionDate).getTime();
      const db = new Date(b.interactionDate).getTime();
      if (db !== da) return db - da;
      return (a.sameDayOrder ?? 0) - (b.sameDayOrder ?? 0);
    });
  }, [interactions]);

  function openCreate() {
    setEditing(null);
    setFormType("note");
    setFormDate(format(new Date(), "yyyy-MM-dd"));
    setFormSummary("");
    setFormNotes("");
    setFormActions("");
    setEditorOpen(true);
  }

  function openEdit(i: TimelineInteraction) {
    setEditing(i);
    setFormType(i.interactionType || "note");
    setFormDate(format(new Date(i.interactionDate), "yyyy-MM-dd"));
    setFormSummary((i.aiSummary || "").trim());
    setFormNotes((i.rawNotes || "").trim());
    setFormActions((i.actionItems || []).join("\n"));
    setEditorOpen(true);
  }

  function save() {
    const actionItems = formActions
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    start(async () => {
      try {
        if (editing) {
          await updateInteraction(editing.id, {
            interactionType: formType,
            interactionDate: formDate,
            aiSummary: formSummary.trim() || undefined,
            rawNotes: formNotes.trim() || undefined,
            actionItems,
            parseDateFromNotes: !formDate,
          });
          toast.success("Interaction updated");
        } else {
          await logInteraction({
            contactId,
            interactionType: formType,
            interactionDate: formDate || undefined,
            aiSummary: formSummary.trim() || undefined,
            rawNotes: formNotes.trim() || undefined,
            actionItems,
            parseDateFromNotes: true,
          });
          toast.success("Interaction added");
        }
        setEditorOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not save interaction"
        );
      }
    });
  }

  function move(i: TimelineInteraction, direction: -1 | 1) {
    const key = dayKey(i.interactionDate);
    const sameDay = sorted.filter((x) => dayKey(x.interactionDate) === key);
    const idx = sameDay.findIndex((x) => x.id === i.id);
    const swapWith = sameDay[idx + direction];
    if (!swapWith) return;

    const ordered = sameDay.map((x) => x.id);
    const j = idx + direction;
    [ordered[idx], ordered[j]] = [ordered[j], ordered[idx]];

    start(async () => {
      try {
        await reorderSameDayInteractions(contactId, key, ordered);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not reorder"
        );
      }
    });
  }

  return (
    <section
      id="interaction-timeline"
      className="scroll-mt-24 border-t border-border/50 pt-6"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Timeline
        </h2>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={openCreate}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No interactions yet. Add a note or import messages to build history.
        </p>
      ) : (
        <ul className="space-y-5">
          {sorted.map((i) => {
            const key = dayKey(i.interactionDate);
            const sameDay = sorted.filter(
              (x) => dayKey(x.interactionDate) === key
            );
            const idx = sameDay.findIndex((x) => x.id === i.id);
            const canUp = idx > 0;
            const canDown = idx < sameDay.length - 1 && sameDay.length > 1;
            const hasNotes = Boolean(i.rawNotes?.trim());

            return (
              <li key={i.id} className="border-l-2 border-primary/25 pl-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(i.interactionDate), "MMM d, yyyy")} ·{" "}
                      <span className="capitalize">
                        {typeLabel(i.interactionType)}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-primary">{oneLine(i)}</p>
                    {(i.actionItems || []).length > 0 ? (
                      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                        {i.actionItems!.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {sameDay.length > 1 ? (
                      <>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={pending || !canUp}
                          aria-label="Move earlier in day"
                          onClick={() => move(i, -1)}
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={pending || !canDown}
                          aria-label="Move later in day"
                          onClick={() => move(i, 1)}
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                      </>
                    ) : null}
                    {hasNotes ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Open notes"
                        onClick={() => setNotesOpen(i)}
                      >
                        <FileText className="size-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit interaction"
                      onClick={() => openEdit(i)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet open={Boolean(notesOpen)} onOpenChange={(o) => !o && setNotesOpen(null)}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Notes</SheetTitle>
          </SheetHeader>
          <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-primary">
            {notesOpen?.rawNotes?.trim() || "No notes."}
          </p>
        </SheetContent>
      </Sheet>

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {editing ? "Edit interaction" : "Add interaction"}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={formType}
                onValueChange={(v) => setFormType(v || "note")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="interaction-date">Date</Label>
              <Input
                id="interaction-date"
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                If the notes mention a date, we&apos;ll use that when you leave
                this blank on create.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="interaction-summary">One-line summary</Label>
              <Input
                id="interaction-summary"
                value={formSummary}
                onChange={(e) => setFormSummary(e.target.value)}
                placeholder="What happened"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="interaction-notes">Notes</Label>
              <Textarea
                id="interaction-notes"
                rows={5}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="interaction-actions">
                Action items (one per line)
              </Label>
              <Textarea
                id="interaction-actions"
                rows={3}
                value={formActions}
                onChange={(e) => setFormActions(e.target.value)}
              />
            </div>
            <Button
              type="button"
              disabled={pending || (!formSummary.trim() && !formNotes.trim())}
              onClick={save}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
