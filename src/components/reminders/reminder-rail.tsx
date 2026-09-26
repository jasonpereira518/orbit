"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ComponentType } from "react";
import {
  CalendarClock,
  CheckCheck,
  MoreHorizontal,
  Plus,
  Sparkles,
  Sun,
  Infinity as InfinityIcon,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createReminderList,
  deleteReminderList,
} from "@/actions/reminders";
import {
  ReminderCalendarSync,
  type CalendarSyncSummary,
} from "@/components/reminders/reminder-calendar-sync";
import { ReminderListEditor } from "@/components/reminders/reminder-list-editor";
import { ListGlyph } from "@/components/reminders/list-glyph";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import type {
  ReminderListSummary,
  ReminderRailCounts,
  ReminderView,
} from "@/lib/reminders-page";
import { cn } from "@/lib/utils";

/** What the queue is showing. `suggested` is the review queue for note-extracted dates. */
export type RailTarget =
  | { kind: "view"; view: ReminderView | "suggested" }
  | { kind: "list"; id: string };

export function sameTarget(a: RailTarget, b: RailTarget) {
  return a.kind === "view" && b.kind === "view"
    ? a.view === b.view
    : a.kind === "list" && b.kind === "list" && a.id === b.id;
}

const VIEWS: Array<{
  view: ReminderView;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count: (c: ReminderRailCounts) => number;
}> = [
  { view: "today", label: "Today", icon: Sun, count: (c) => c.today },
  { view: "upcoming", label: "Upcoming", icon: CalendarClock, count: (c) => c.upcoming },
  { view: "anytime", label: "Anytime", icon: InfinityIcon, count: (c) => c.anytime },
  { view: "done", label: "Done", icon: CheckCheck, count: (c) => c.done },
];

/**
 * The reminders rail: smart views first (triage is what the page is for), then the
 * suggestion review queue when it has anything in it, then your lists.
 */
export function ReminderRail({
  counts,
  lists,
  target,
  onSelect,
  calendar,
}: {
  counts: ReminderRailCounts;
  lists: ReminderListSummary[];
  target: RailTarget;
  onSelect: (target: RailTarget) => void;
  /** Calendar sync's state, for the row at the rail's foot. */
  calendar?: CalendarSyncSummary;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [newName, setNewName] = useState("");
  const [editor, setEditor] = useState<{ list: ReminderListSummary; anchor: HTMLElement } | null>(
    null
  );
  const [deleting, setDeleting] = useState<ReminderListSummary | null>(null);

  function createList() {
    const name = newName.trim();
    if (!name) return;
    start(async () => {
      try {
        const res = await createReminderList(name);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setNewName("");
        toast.success("List created");
        onSelect({ kind: "list", id: res.value.id });
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t create that list — try again?"));
      }
    });
  }

  function openEditor(list: ReminderListSummary, anchor: HTMLElement) {
    setEditor({ list, anchor });
  }

  function confirmDelete() {
    const list = deleting;
    if (!list) return;
    start(async () => {
      try {
        const res = await deleteReminderList(list.id);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success("List deleted");
        setDeleting(null);
        if (target.kind === "list" && target.id === list.id) {
          onSelect({ kind: "list", id: res.value.inboxId });
        }
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.deleteFailed));
      }
    });
  }

  return (
    <nav aria-label="Reminder views and lists" className="space-y-5">
      <ul className="space-y-0.5">
        {VIEWS.map(({ view, label, icon: Icon, count }) => {
          const active = target.kind === "view" && target.view === view;
          const n = count(counts);
          return (
            <li key={view}>
              <RailButton
                active={active}
                onClick={() => onSelect({ kind: "view", view })}
                icon={<Icon className="size-4" />}
                label={label}
                trailing={
                  // One number. Overdue is a tint on it (and a dot, so it doesn't rest on
                  // colour alone) rather than a second count beside it — "3 3" read as a typo
                  // whenever everything due was overdue.
                  view === "today" && counts.overdue > 0 ? (
                    <span
                      className="flex items-center gap-1.5 font-medium tabular-nums text-amber-700 dark:text-warning"
                      title={`${counts.overdue} overdue`}
                    >
                      <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                      {n}
                      <span className="sr-only">, {counts.overdue} overdue</span>
                    </span>
                  ) : n > 0 ? (
                    <span className="tabular-nums">{n}</span>
                  ) : null
                }
              />
            </li>
          );
        })}
        {counts.suggested > 0 && (
          <li>
            <RailButton
              active={target.kind === "view" && target.view === "suggested"}
              onClick={() => onSelect({ kind: "view", view: "suggested" })}
              icon={<Sparkles className="size-4 text-amber-600 dark:text-amber-300" />}
              label="Suggested"
              className="text-amber-900 dark:text-amber-100"
              trailing={
                <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium tabular-nums text-amber-800 dark:text-amber-200">
                  {counts.suggested}
                  <span className="sr-only"> to review</span>
                </span>
              }
            />
          </li>
        )}
      </ul>

      <div>
        <h2 className="mb-1.5 px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Lists
        </h2>
        <ul className="space-y-0.5">
          {lists.map((list) => {
            const active = target.kind === "list" && target.id === list.id;
            const editing = editor?.list.id === list.id;
            return (
              <li
                key={list.id}
                className="group/list relative"
                // Right-click opens the list's editor, anchored to the row.
                onContextMenu={(e) => {
                  e.preventDefault();
                  openEditor(list, e.currentTarget);
                }}
              >
                <RailButton
                  active={active || editing}
                  onClick={() => onSelect({ kind: "list", id: list.id })}
                  icon={<ListGlyph list={list} />}
                  label={list.name}
                  trailing={
                    list.pendingCount > 0 ? (
                      <span
                        className={cn(
                          "tabular-nums",
                          // Makes way for ⋯: on hover with a mouse, always on touch.
                          "[@media(hover:hover)]:group-hover/list:opacity-0 [@media(hover:hover)]:group-focus-within/list:opacity-0 [@media(hover:none)]:hidden",
                          editing && "opacity-0"
                        )}
                      >
                        {list.pendingCount}
                      </span>
                    ) : null
                  }
                />
                {/* The editor's way in for touch and keyboard, which have no right-click.
                    Revealed on hover with a mouse; always shown on touch. */}
                <div
                  className={cn(
                    "absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity duration-fast group-hover/list:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
                    editing && "opacity-100"
                  )}
                >
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit ${list.name}`}
                    title="Rename, icon and color (or right-click)"
                    className="tap-target relative"
                    onClick={(e) => {
                      const row = e.currentTarget.closest("li");
                      openEditor(list, row instanceof HTMLElement ? row : e.currentTarget);
                    }}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <form
          className="mt-2 flex gap-1 px-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            createList();
          }}
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New list"
            aria-label="New list name"
            className="h-8"
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="outline"
            disabled={pending || !newName.trim()}
            aria-label="Add list"
            className="tap-target relative"
          >
            <Plus className="size-3.5" />
          </Button>
        </form>
      </div>

      {calendar && (
        <div className="border-t border-border/60 pt-3">
          <ReminderCalendarSync initial={calendar} />
        </div>
      )}

      {editor && (
        <ReminderListEditor
          key={editor.list.id}
          list={editor.list}
          anchor={editor.anchor}
          onClose={() => setEditor(null)}
          onRequestDelete={(list) => {
            setEditor(null);
            setDeleting(list);
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>
              Its reminders move to your Inbox. Nothing else is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleting(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={pending}>
              {pending ? "Deleting…" : "Delete list"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  );
}

function RailButton({
  active,
  onClick,
  icon,
  label,
  trailing,
  className,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-fast",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        className
      )}
    >
      <span className={cn("shrink-0", active ? "text-primary" : "")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing && <span className="shrink-0 text-xs text-muted-foreground">{trailing}</span>}
    </button>
  );
}
