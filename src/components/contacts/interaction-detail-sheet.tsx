"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SELECTABLE_INTERACTION_TYPES,
  interactionFamilySpec,
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
 * The detail behind one timeline node.
 *
 * Laid out as a document — fixed header, scrolling body, pinned footer — rather than a stack
 * that ends wherever the content happens to stop. A thin interaction (a line of notes and
 * nothing else) is common, and the previous layout left its action bar floating in the middle
 * of an empty panel, which read as broken rather than merely empty. The footer being welded to
 * the bottom edge is what makes "not much here" look deliberate.
 *
 * Contact identity is deliberately absent: this only opens from that contact's own profile, so
 * a name and avatar would restate the page behind it.
 */
export function InteractionDetailSheet({
  interactionId,
  canReorder,
  onReorder,
  canStep,
  onStep,
  onOpenChange,
}: {
  interactionId: string | null;
  canReorder: { up: boolean; down: boolean };
  onReorder: (direction: -1 | 1) => void;
  /** Whether a newer/older interaction exists to step to. */
  canStep: { newer: boolean; older: boolean };
  /** -1 steps to the newer interaction, 1 to the older — matching the timeline's order. */
  onStep: (direction: -1 | 1) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [detail, setDetail] = useState<InteractionDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
    setConfirmOpen(false);
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
    setConfirmOpen(false);
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
  const typeFamily = interactionFamilySpec(detail?.interactionType ?? null);
  const hasNotes = Boolean(detail?.rawNotes?.trim());
  const canMove = canReorder.up || canReorder.down;

  return (
    <Sheet
      open={Boolean(interactionId)}
      onOpenChange={(next) => !next && close()}
    >
      {/* The popup itself must NOT scroll — SheetFooter pins with `mt-auto`, which only
          works when the body is the scroller. */}
      <SheetContent className="overflow-hidden sm:max-w-lg">
        <SheetHeader className="border-b border-border/50 pb-4 pr-12">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
                typeFamily.node
              )}
            >
              <typeSpec.icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle>
                {detail
                  ? interactionTypeLabel(detail.interactionType)
                  : "Interaction"}
              </SheetTitle>
              {/* Not truncated: at the panel's desktop width the compact date fits on one
                  line, and on a narrow viewport wrapping to two reads better than clipping
                  the year off the end. */}
              <SheetDescription>
                {detail
                  ? `${format(new Date(detail.interactionDate), "EEE, MMM d, yyyy")} · ${formatDistanceToNow(new Date(detail.interactionDate), { addSuffix: true })}`
                  : "Loading…"}
              </SheetDescription>
            </div>
            {canStep.newer || canStep.older ? (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pending || !canStep.newer}
                  aria-label="Newer interaction"
                  onClick={() => onStep(-1)}
                >
                  <ChevronUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pending || !canStep.older}
                  aria-label="Older interaction"
                  onClick={() => onStep(1)}
                >
                  <ChevronDown className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
        </SheetHeader>

        {loading ? (
          <div className="flex-1 space-y-3 overflow-y-auto px-4">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : !detail ? (
          <div className="flex-1" />
        ) : editing ? (
          <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-2">
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {SELECTABLE_INTERACTION_TYPES.map((t) => {
                  const fam = interactionFamilySpec(t.value);
                  const on = t.value === formType;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setFormType(t.value)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors",
                        on
                          ? fam.chip
                          : "border-border/60 text-muted-foreground hover:text-ink"
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          on ? fam.dot : "bg-muted-foreground/40"
                        )}
                      />
                      <span className="truncate">{t.label}</span>
                    </button>
                  );
                })}
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
          </div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-2">
            <div>
              <SectionLabel>What you learned</SectionLabel>
              {detail.aiSummary?.trim() ? (
                <p className="text-sm leading-relaxed text-ink">
                  {detail.aiSummary.trim()}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {hasNotes
                    ? "No summary yet — Summarize pulls one out of the notes."
                    : "No summary yet. Add notes and this fills itself in."}
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
                        className="flex items-start gap-3 rounded-xl border border-border/50 p-3"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={done}
                          disabled={
                            pending || done || !detail.actionItemsCheckable
                          }
                          onCheckedChange={() => !done && toggleItem(item.id)}
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
              {hasNotes ? (
                <p className="whitespace-pre-wrap rounded-xl border border-border/50 bg-muted/30 p-3 text-sm leading-relaxed text-ink">
                  {detail.rawNotes!.trim()}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing was written down for this one.
                </p>
              )}
            </div>
          </div>
        )}

        {detail ? (
          <SheetFooter className="flex-row items-center gap-2 border-t border-border/50">
            {editing ? (
              <>
                <Button type="button" size="sm" disabled={pending} onClick={saveEdit}>
                  {pending ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
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
                {hasNotes ? (
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
                <DropdownMenu>
                  <DropdownMenuTrigger
                    type="button"
                    aria-label="More actions"
                    className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[9rem]">
                    {canMove ? (
                      <>
                        <DropdownMenuItem
                          disabled={pending || !canReorder.up}
                          onClick={() => onReorder(-1)}
                        >
                          <ArrowUp />
                          Move earlier
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={pending || !canReorder.down}
                          onClick={() => onReorder(1)}
                        >
                          <ArrowDown />
                          Move later
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={pending}
                      onClick={() => setConfirmOpen(true)}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </SheetFooter>
        ) : null}
      </SheetContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this interaction?</DialogTitle>
            <DialogDescription>
              Its notes and action items go with it. Reminders it created are
              kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={remove}>
              <Trash2 className="size-3.5" />
              Delete interaction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
