"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
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
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  TimelineDateScrubber,
  monthKeyFromDate,
  monthLabel,
  monthShort,
} from "@/components/contacts/timeline-date-scrubber";

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
  const listRef = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const [notesOpen, setNotesOpen] = useState<TimelineInteraction | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TimelineInteraction | null>(null);
  const [formType, setFormType] = useState("note");
  const [formDate, setFormDate] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formActions, setFormActions] = useState("");
  const [activeMonth, setActiveMonth] = useState<string | null>(null);

  const sorted = useMemo(() => {
    return [...interactions].sort((a, b) => {
      const da = new Date(a.interactionDate).getTime();
      const db = new Date(b.interactionDate).getTime();
      if (db !== da) return db - da;
      return (a.sameDayOrder ?? 0) - (b.sameDayOrder ?? 0);
    });
  }, [interactions]);

  const monthGroups = useMemo(() => {
    const groups: Array<{
      monthKey: string;
      label: string;
      shortLabel: string;
      items: TimelineInteraction[];
    }> = [];
    const map = new Map<string, TimelineInteraction[]>();
    for (const i of sorted) {
      const key = monthKeyFromDate(i.interactionDate);
      const list = map.get(key) || [];
      list.push(i);
      map.set(key, list);
    }
    for (const [monthKey, items] of map) {
      groups.push({
        monthKey,
        label: monthLabel(items[0].interactionDate),
        shortLabel: monthShort(items[0].interactionDate),
        items,
      });
    }
    return groups;
  }, [sorted]);

  const scrubPoints = useMemo(
    () =>
      monthGroups.map((g) => ({
        id: g.monthKey,
        monthKey: g.monthKey,
        label: g.label,
        shortLabel: g.shortLabel,
      })),
    [monthGroups]
  );

  useEffect(() => {
    if (!activeMonth && monthGroups[0]) {
      setActiveMonth(monthGroups[0].monthKey);
    }
  }, [activeMonth, monthGroups]);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;

    const sections = root.querySelectorAll<HTMLElement>("[data-month-key]");
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target.getAttribute("data-month-key");
        if (first) setActiveMonth(first);
      },
      { root, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [monthGroups]);

  function scrollToMonth(monthKey: string) {
    setActiveMonth(monthKey);
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-month-key="${monthKey}"]`
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
    <Card id="interaction-timeline" className="scroll-mt-24 border-border/70 shadow-none">
      <CardHeader className="border-b border-border/50">
        <CardTitle>Timeline</CardTitle>
        <CardAction>
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
        </CardAction>
      </CardHeader>
      <CardContent className="pt-4">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No interactions yet. Add a note or import messages to build history.
          </p>
        ) : (
          <div className="flex gap-3">
            <div
              ref={listRef}
              className="min-h-0 max-h-[28rem] flex-1 overflow-y-auto overscroll-contain pr-1"
            >
              <div className="space-y-6">
                {monthGroups.map((group) => (
                  <section
                    key={group.monthKey}
                    data-month-key={group.monthKey}
                    id={`timeline-month-${group.monthKey}`}
                    className="scroll-mt-2"
                  >
                    <h3 className="sticky top-0 z-[1] mb-3 bg-card/95 py-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">
                      {group.label}
                    </h3>
                    <ul className="space-y-4">
                      {group.items.map((i) => {
                        const key = dayKey(i.interactionDate);
                        const sameDay = group.items.filter(
                          (x) => dayKey(x.interactionDate) === key
                        );
                        const idx = sameDay.findIndex((x) => x.id === i.id);
                        const canUp = idx > 0;
                        const canDown =
                          idx < sameDay.length - 1 && sameDay.length > 1;
                        const hasNotes = Boolean(i.rawNotes?.trim());

                        return (
                          <li
                            key={i.id}
                            data-day-key={key}
                            className="border-l-2 border-primary/25 pl-4"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-muted-foreground">
                                  {format(
                                    new Date(i.interactionDate),
                                    "MMM d, yyyy"
                                  )}{" "}
                                  ·{" "}
                                  <span className="capitalize">
                                    {typeLabel(i.interactionType)}
                                  </span>
                                </p>
                                <p className="mt-1 text-sm text-primary">
                                  {oneLine(i)}
                                </p>
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
                  </section>
                ))}
              </div>
            </div>

            <TimelineDateScrubber
              points={scrubPoints}
              activeMonthKey={activeMonth}
              onSelectMonth={scrollToMonth}
              className="hidden sm:flex"
            />
          </div>
        )}
      </CardContent>

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
        <SheetContent className="overflow-y-auto sm:max-w-md">
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
    </Card>
  );
}
