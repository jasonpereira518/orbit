"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowDown,
  ArrowUp,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  deleteInteraction,
  getInteractionDetail,
  resummarizeInteraction,
  updateInteraction,
  type InteractionDetail,
} from "@/actions/contacts";
import { setActionItemStatus } from "@/actions/action-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  INTERACTION_TYPES,
  interactionTypeLabel,
  interactionTypeSpec,
  normalizeInteractionType,
} from "@/lib/interaction-types";
import { cn } from "@/lib/utils";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The detail behind one timeline node: what was learned, what was promised, who else came up,
 * and the notes it all came from — plus the edit/re-summarize/delete controls that used to be
 * scattered across icon buttons on the timeline row itself.
 *
 * Content loads when the sheet opens rather than with the profile, so a contact with hundreds
 * of interactions does not pay for detail nobody asked to see.
 */
export function InteractionDetailSheet({
  interactionId,
  canReorder,
  onReorder,
  onOpenChange,
}: {
  interactionId: string | null;
  canReorder: { up: boolean; down: boolean };
  onReorder: (direction: -1 | 1) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [detail, setDetail] = useState<InteractionDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const [formType, setFormType] = useState("note");
  const [formDate, setFormDate] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [formNotes, setFormNotes] = useState("");

  const load = useCallback(
    async (id: string) => {
      try {
        setDetail(await getInteractionDetail(id));
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not load this interaction"
        );
        onOpenChange(false);
      }
    },
    [onOpenChange]
  );

  // Derived, not stored: the sheet is loading exactly while the detail it holds is not the
  // one that was asked for. One less piece of state to keep in step.
  const loading = Boolean(interactionId) && detail?.id !== interactionId;

  useEffect(() => {
    if (!interactionId) return;
    void load(interactionId);
  }, [interactionId, load]);

  /** Closing resets here rather than in an effect, so reopening never flashes stale detail. */
  function close() {
    setDetail(null);
    setEditing(false);
    setChecked(new Set());
    onOpenChange(false);
  }

  function beginEdit() {
    if (!detail) return;
    setFormType(normalizeInteractionType(detail.interactionType));
    setFormDate(format(new Date(detail.interactionDate), "yyyy-MM-dd"));
    setFormSummary((detail.aiSummary || "").trim());
    setFormNotes((detail.rawNotes || "").trim());
    setEditing(true);
  }

  function saveEdit() {
    if (!detail) return;
    start(async () => {
      try {
        await updateInteraction(detail.id, {
          interactionType: formType,
          interactionDate: formDate,
          aiSummary: formSummary.trim(),
          rawNotes: formNotes.trim(),
        });
        toast.success("Interaction updated");
        setEditing(false);
        await load(detail.id);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  function resummarize() {
    if (!detail) return;
    start(async () => {
      try {
        await resummarizeInteraction(detail.id);
        toast.success("Summary refreshed");
        await load(detail.id);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not summarize those notes"
        );
      }
    });
  }

  function remove() {
    if (!detail) return;
    if (
      !window.confirm(
        "Delete this interaction? Its notes and action items go with it. Reminders it created are kept."
      )
    ) {
      return;
    }
    start(async () => {
      try {
        await deleteInteraction(detail.id);
        toast.success("Interaction deleted");
        close();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete");
      }
    });
  }

  function toggleItem(id: string) {
    setChecked((prev) => new Set(prev).add(id));
    start(async () => {
      try {
        await setActionItemStatus(id, "done");
        router.refresh();
      } catch (err) {
        setChecked((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.error(
          err instanceof Error ? err.message : "Could not update action item"
        );
      }
    });
  }

  // Read off the spec at the point of use: binding a lookup's result to a capitalized
  // local reads as constructing a component during render.
  const typeSpec = interactionTypeSpec(detail?.interactionType ?? null);

  return (
    <Sheet
      open={Boolean(interactionId)}
      onOpenChange={(next) => !next && close()}
    >
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-full border border-border/70 bg-primary/10">
              <typeSpec.icon className="size-3.5 text-primary" />
            </span>
            {detail
              ? interactionTypeLabel(detail.interactionType)
              : "Interaction"}
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : !detail ? null : editing ? (
          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {INTERACTION_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    aria-pressed={t.value === formType}
                    onClick={() => setFormType(t.value)}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-xs transition-colors",
                      t.value === formType
                        ? "border-primary/60 bg-primary/10 text-ink"
                        : "border-border/60 text-muted-foreground hover:text-ink"
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-interaction-date">Date</Label>
              <Input
                id="edit-interaction-date"
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-interaction-summary">Summary</Label>
              <Input
                id="edit-interaction-summary"
                value={formSummary}
                onChange={(e) => setFormSummary(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-interaction-notes">Notes</Label>
              <Textarea
                id="edit-interaction-notes"
                rows={8}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" disabled={pending} onClick={saveEdit}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <p className="text-sm text-muted-foreground">
              {format(new Date(detail.interactionDate), "EEEE, MMMM d, yyyy")}
            </p>

            <div>
              <SectionLabel>What you learned</SectionLabel>
              {detail.aiSummary?.trim() ? (
                <p className="text-sm leading-relaxed text-ink">
                  {detail.aiSummary.trim()}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No summary yet.{" "}
                  {detail.rawNotes?.trim()
                    ? "Summarize pulls one out of the notes below."
                    : "Add notes and this fills itself in."}
                </p>
              )}
            </div>

            {detail.topics.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.topics.map((topic) => (
                  <Badge key={topic} variant="outline" className="text-[11px]">
                    {topic}
                  </Badge>
                ))}
              </div>
            )}

            {detail.actionItems.length > 0 && (
              <div>
                <SectionLabel>Action items</SectionLabel>
                <div className="space-y-2">
                  {detail.actionItems.map((item) => {
                    const done = item.status === "done" || checked.has(item.id);
                    return (
                      <label
                        key={item.id}
                        className="flex items-start gap-3 rounded-xl border border-border/60 p-3"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={done}
                          disabled={
                            pending || done || !detail.actionItemsCheckable
                          }
                          onCheckedChange={() =>
                            !done && toggleItem(item.id)
                          }
                          aria-label={`Mark "${item.text}" done`}
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              "text-sm",
                              done
                                ? "text-muted-foreground line-through"
                                : "text-ink"
                            )}
                          >
                            {item.text}
                          </p>
                          {item.reminderId ? (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px]"
                            >
                              reminder set
                            </Badge>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {detail.mentions.length > 0 && (
              <div>
                <SectionLabel>Also came up</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {detail.mentions.map((m) => (
                    <Link
                      key={m.contactId}
                      href={`/contacts/${m.contactId}`}
                      className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-ink transition-colors hover:border-primary/50 hover:text-primary"
                    >
                      {m.fullName}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div>
              <SectionLabel>Notes</SectionLabel>
              {detail.rawNotes?.trim() ? (
                <p className="whitespace-pre-wrap rounded-xl border border-border/60 p-3 text-sm leading-relaxed text-ink">
                  {detail.rawNotes.trim()}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing was written down for this one.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-4">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={pending}
                onClick={beginEdit}
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
              {detail.rawNotes?.trim() ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={pending}
                  onClick={resummarize}
                >
                  <Sparkles className="size-3.5" />
                  {pending ? "Working…" : "Summarize"}
                </Button>
              ) : null}
              {canReorder.up || canReorder.down ? (
                <div className="flex items-center gap-0.5">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending || !canReorder.up}
                    aria-label="Move earlier in day"
                    onClick={() => onReorder(-1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending || !canReorder.down}
                    aria-label="Move later in day"
                    onClick={() => onReorder(1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto gap-1.5 text-destructive hover:text-destructive"
                disabled={pending}
                onClick={remove}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
