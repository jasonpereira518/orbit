"use client";

/**
 * Typed opportunities on a contact: what this relationship might actually produce.
 *
 * Composed entirely from the primitives that exist — `Select` for the kind (the only listbox
 * in the set, and a twelve-value enum is what it is for), hand-rolled `aria-pressed` buttons
 * for the status (copied from the interaction-type picker in `log-interaction-sheet.tsx`),
 * and a `<ul>` of bordered rows rather than a table. No `cmdk`, no combobox, no tabs
 * primitive: none of those exist in `components/ui`, and adding one for this would be a
 * design-system decision made by a feature.
 *
 * Renders even when empty, unlike `ContactMentionsSection`, because it carries an Add button —
 * an empty section with an affordance is worth the space, an empty section without one is not.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createOpportunity,
  deleteOpportunity,
  restoreOpportunity,
  setOpportunityStatus,
  updateOpportunity,
} from "@/actions/opportunities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  OPPORTUNITY_KINDS,
  OPPORTUNITY_STATUSES,
  isOpenOpportunityStatus,
  opportunityKindLabel,
} from "@/lib/opportunity-kinds";
import type { Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";

export type ContactOpportunityRow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  direction: string | null;
  dueDate: Date | string | null;
  sourceExcerpt: string | null;
  sourceInteractionId: string | null;
  createdBy: string;
};

/** The status's own tone word (from `opportunity-kinds`) → the app's status tone. */
const STATUS_TONE: Record<string, Tone> = {
  open: "accent",
  active: "warning",
  good: "success",
  bad: "neutral",
  muted: "neutral",
};

function toneFor(status: string): Tone {
  return STATUS_TONE[OPPORTUNITY_STATUSES.find((s) => s.value === status)?.tone ?? "muted"] ?? "neutral";
}

function dueLabel(due: Date | string | null) {
  if (!due) return null;
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? null : format(d, "MMM d, yyyy");
}

function isoOf(due: Date | string | null) {
  if (!due) return "";
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Draft = {
  id: string | null;
  kind: string;
  label: string;
  dueDateIso: string;
};

const EMPTY_DRAFT: Draft = { id: null, kind: "referral", label: "", dueDateIso: "" };

export function ContactOpportunitiesSection({
  contactId,
  contactName,
  opportunities,
}: {
  contactId: string;
  contactName: string;
  opportunities: ContactOpportunityRow[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [pending, start] = useTransition();

  const open = opportunities.filter((o) => isOpenOpportunityStatus(o.status));
  const closed = opportunities.filter((o) => !isOpenOpportunityStatus(o.status));
  const visible = showClosed ? [...open, ...closed] : open;

  function save() {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) {
      toast.error("Give the opportunity a short label");
      return;
    }
    start(async () => {
      const res = draft.id
        ? await updateOpportunity(draft.id, {
            kind: draft.kind,
            label,
            dueDateIso: draft.dueDateIso || null,
          })
        : await createOpportunity({
            contactId,
            kind: draft.kind,
            label,
            dueDateIso: draft.dueDateIso || null,
          });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(draft.id ? "Opportunity updated" : "Opportunity added");
      setDraft(null);
      router.refresh();
    });
  }

  function changeStatus(row: ContactOpportunityRow, status: string) {
    start(async () => {
      const res = await setOpportunityStatus(row.id, status);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.refresh();
    });
  }

  /**
   * Optimistic-feeling delete with an Undo toast rather than a confirm dialog. The house
   * pattern (see the note-batch undo in `log-interaction-sheet.tsx`): a second modal to
   * protect a one-line row costs more than the mistake does.
   */
  function remove(row: ContactOpportunityRow) {
    start(async () => {
      const res = await deleteOpportunity(row.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const deleted = res.opportunity;
      toast.success("Opportunity deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            void restoreOpportunity(deleted).then((restored) => {
              if (!restored.ok) toast.error(restored.error);
              router.refresh();
            });
          },
        },
      });
      router.refresh();
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle as="h2">Opportunities</CardTitle>
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft({ ...EMPTY_DRAFT })}
              disabled={pending}
            >
              <Plus className="size-4" />
              Add
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing tracked yet. Opportunities Orbit finds in your notes land here — or add
              one by hand.
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((o) => {
                const due = dueLabel(o.dueDate);
                return (
                  <li
                    key={o.id}
                    className={cn(
                      "rounded-xl border border-border-subtle bg-card p-3",
                      !isOpenOpportunityStatus(o.status) && "opacity-70"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">{opportunityKindLabel(o.kind)}</Badge>
                          <Badge tone={toneFor(o.status)} size="sm">
                            {OPPORTUNITY_STATUSES.find((s) => s.value === o.status)?.label ??
                              "Open"}
                          </Badge>
                          {due && (
                            <span className="text-xs text-muted-foreground">Due {due}</span>
                          )}
                        </div>
                        <p className="text-sm text-foreground">{o.label}</p>
                        {o.sourceExcerpt && (
                          <p className="rounded-lg border border-border-subtle bg-surface-inset p-2 text-xs text-muted-foreground">
                            {o.sourceExcerpt}
                          </p>
                        )}
                        {isOpenOpportunityStatus(o.status) && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {OPPORTUNITY_STATUSES.filter((s) => s.value !== o.status).map((s) => (
                              <Button
                                key={s.value}
                                type="button"
                                variant="outline"
                                size="xs"
                                aria-pressed={false}
                                disabled={pending}
                                onClick={() => changeStatus(o, s.value)}
                                className="h-5 rounded-full px-2 text-2xs font-normal text-muted-foreground"
                              >
                                {s.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Actions for ${o.label}`}
                              disabled={pending}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              setDraft({
                                id: o.id,
                                kind: o.kind,
                                label: o.label,
                                dueDateIso: isoOf(o.dueDate),
                              })
                            }
                          >
                            Edit
                          </DropdownMenuItem>
                          {!isOpenOpportunityStatus(o.status) && (
                            <DropdownMenuItem onClick={() => changeStatus(o, "open")}>
                              Reopen
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem variant="destructive" onClick={() => remove(o)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {closed.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed ? "Hide closed" : `Show ${closed.length} closed`}
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? "Edit opportunity" : `Add an opportunity for ${contactName}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="opportunity-kind">Kind</Label>
              <Select
                value={draft?.kind ?? "referral"}
                onValueChange={(v) => setDraft((d) => (d ? { ...d, kind: String(v) } : d))}
              >
                <SelectTrigger id="opportunity-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPPORTUNITY_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opportunity-label">What is it?</Label>
              <Input
                id="opportunity-label"
                value={draft?.label ?? ""}
                placeholder="could forward my resume to the infra team"
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, label: e.target.value } : d))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opportunity-due">Due (optional)</Label>
              <Input
                id="opportunity-due"
                type="date"
                value={draft?.dueDateIso ?? ""}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, dueDateIso: e.target.value } : d))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {draft?.id ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
