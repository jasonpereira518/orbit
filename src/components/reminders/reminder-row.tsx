"use client";

import Link from "next/link";
import { memo, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import {
  Check,
  Coffee,
  FolderInput,
  Mail,
  MessageCircle,
  MoreHorizontal,
  NotebookPen,
  PanelRightOpen,
  Phone,
  Trash2,
} from "lucide-react";
import type { ReminderActionKind } from "@/db/schema";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReminderSnoozeMenu } from "@/components/reminders/reminder-snooze-menu";
import { ListGlyph } from "@/components/reminders/list-glyph";
import { ACTION_KIND_LABELS } from "@/lib/reminder-action-kind";
import { dueLabelFor } from "@/lib/reminder-due-bucket";
import {
  isNoteworthyType,
  reminderTypeLabel,
  reminderTypeStyle,
} from "@/lib/reminder-display";
import type { ReminderRow as ReminderRowData } from "@/lib/reminders-page";
import { cn } from "@/lib/utils";

/** A list as the Move menus draw it; the style fields are optional for older callers. */
export type ListOption = {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  isInbox?: boolean;
};

export const KIND_ICONS: Record<ReminderActionKind, typeof Phone | null> = {
  call: Phone,
  email: Mail,
  meet: Coffee,
  follow_up: MessageCircle,
  task: null,
};

export type ReminderRowHandlers = {
  onFocusRow: (id: string) => void;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string, range: boolean) => void;
  onDone: (id: string) => void;
  /** Done view: the filled circle takes it back to pending. */
  onReopen: (id: string) => void;
  onSnooze: (id: string, ymd: string, label: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, listId: string) => void;
  onSnoozeOpenChange: (id: string, open: boolean) => void;
  onMoreOpenChange: (id: string, open: boolean) => void;
};

/**
 * One reminder in the queue: dense, one line of title and one of context, with the
 * frequent actions (done, snooze) in reach and the rest behind ⋯.
 *
 * The whole row is the "open details" target and carries the roving focus; the checkbox,
 * done circle and menus stop their clicks so they never also open the pane. Memoized: a
 * long queue re-renders on every selection change, and only the rows whose flags changed
 * need to.
 */
export const ReminderRow = memo(function ReminderRow({
  item,
  today,
  lists,
  selected,
  focused,
  active,
  exiting,
  snoozeOpen,
  moreOpen,
  handlers,
  registerRow,
}: {
  item: ReminderRowData;
  today: string;
  lists: Array<ListOption>;
  selected: boolean;
  focused: boolean;
  /** Its details are open in the pane. */
  active: boolean;
  exiting: boolean;
  snoozeOpen: boolean;
  moreOpen: boolean;
  handlers: ReminderRowHandlers;
  /** Records this row's `<li>` under its id (null on detach). Stable, so the memo holds. */
  registerRow?: (id: string, el: HTMLLIElement | null) => void;
}) {
  // No cleanup returned, so React calls it with null on detach — as the old inline ref did.
  const rowRef = useCallback(
    (el: HTMLLIElement | null) => {
      registerRow?.(item.id, el);
    },
    [registerRow, item.id]
  );
  const due = dueLabelFor(item.dueDay, today);
  const KindIcon = KIND_ICONS[item.actionKind];
  const isDone = item.status === "done";
  const stop = (e: MouseEvent) => e.stopPropagation();

  function onKeyDown(e: KeyboardEvent<HTMLLIElement>) {
    // Space toggles selection, as in a mail client; Enter is the queue's (open).
    if (e.key === " " && e.target === e.currentTarget) {
      e.preventDefault();
      handlers.onToggleSelect(item.id, e.shiftKey);
    }
  }

  return (
    <li
      ref={rowRef}
      data-reminder-id={item.id}
      tabIndex={focused ? 0 : -1}
      aria-current={active ? "true" : undefined}
      onFocus={(e) => {
        if (e.target === e.currentTarget) handlers.onFocusRow(item.id);
      }}
      onClick={(e) => {
        if (exiting) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          handlers.onToggleSelect(item.id, e.shiftKey);
          return;
        }
        handlers.onFocusRow(item.id);
        handlers.onOpen(item.id);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        // Collapses on exit via grid rows, like the contacts list: a motion FLIP over a
        // long list reconciles every row on every commit.
        "group/row grid cursor-pointer [contain-intrinsic-size:auto_60px] [content-visibility:auto]",
        "transition-[grid-template-rows,opacity] duration-slow ease-house",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
        exiting ? "pointer-events-none grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
      )}
    >
      <div className="overflow-hidden">
        <div
          className={cn(
            // Coarse pointers: the checkbox's and the done circle's enlarged hit areas each reach
            // 12px past their edges, so they need 24px between them to not overlap.
            "relative flex items-start gap-2.5 px-3 py-2.5 transition-[background-color,translate] duration-slow ease-house pointer-coarse:gap-6 sm:px-4",
            "hover:bg-muted/40",
            selected && "bg-primary/[0.06] hover:bg-primary/[0.09]",
            active && "bg-muted/60",
            exiting && "-translate-x-6"
          )}
        >
          {/* The active row's marker: a bar, so it reads without relying on tint alone. */}
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary transition-opacity duration-fast",
              active ? "opacity-100" : "opacity-0"
            )}
          />
          <div className="flex h-6 items-center" onClick={stop}>
            <Checkbox
              checked={selected}
              onCheckedChange={() => handlers.onToggleSelect(item.id, false)}
              aria-label={`Select “${item.title}”`}
              tabIndex={-1}
              className={cn(
                "transition-opacity duration-fast",
                // Hidden until wanted on pointer devices; always there on touch, where
                // there is no hover to reveal it.
                !selected && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100"
              )}
            />
          </div>

          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              stop(e);
              if (isDone) handlers.onReopen(item.id);
              else handlers.onDone(item.id);
            }}
            aria-label={isDone ? `Mark “${item.title}” not done` : `Mark “${item.title}” done`}
            title={isDone ? "Reopen" : "Mark done (e)"}
            className={cn(
              "group/done tap-target relative mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-fast",
              isDone
                ? "border-primary bg-primary text-primary-foreground"
                : due?.bucket === "overdue"
                  ? "border-amber-500/70 hover:border-primary hover:bg-primary/10"
                  : "border-border hover:border-primary hover:bg-primary/10"
            )}
          >
            <Check
              className={cn(
                "size-3 transition-opacity duration-fast",
                isDone ? "opacity-100" : "text-primary opacity-0 group-hover/done:opacity-100"
              )}
            />
          </button>

          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm font-medium leading-6 text-foreground",
                isDone && "text-muted-foreground line-through decoration-muted-foreground/50"
              )}
            >
              {item.title}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {due && (
                <span
                  className={cn(
                    "tabular-nums",
                    due.bucket === "overdue" && "font-medium text-amber-700 dark:text-warning",
                    due.bucket === "today" && "font-medium text-primary"
                  )}
                >
                  {due.text}
                </span>
              )}
              {item.contactName && (
                <span className="min-w-0 truncate">
                  {due && <span aria-hidden className="mr-2 text-border">·</span>}
                  {item.contactName}
                </span>
              )}
              {KindIcon && (
                <span className="inline-flex items-center gap-1" title={ACTION_KIND_LABELS[item.actionKind]}>
                  <KindIcon className="size-3" aria-hidden />
                  <span className="sr-only sm:not-sr-only">{ACTION_KIND_LABELS[item.actionKind]}</span>
                </span>
              )}
              {isNoteworthyType(item.reminderType, item.noteBatchId) && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
                    reminderTypeStyle(item.reminderType)
                  )}
                >
                  {reminderTypeLabel(item.reminderType, item.noteBatchId)}
                </span>
              )}
            </div>
          </div>

          {/* Visible on hover/focus with a pointer; always on touch. Kept mounted while a
              menu is open so the popup doesn't lose its anchor. */}
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 transition-opacity duration-fast pointer-coarse:gap-4",
              snoozeOpen || moreOpen
                ? "opacity-100"
                : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100"
            )}
            onClick={stop}
          >
            {!isDone && (
              <ReminderSnoozeMenu
                today={today}
                open={snoozeOpen}
                onOpenChange={(open) => handlers.onSnoozeOpenChange(item.id, open)}
                onPick={(ymd, label) => handlers.onSnooze(item.id, ymd, label)}
              />
            )}
            <DropdownMenu
              open={moreOpen}
              onOpenChange={(open) => handlers.onMoreOpenChange(item.id, open)}
            >
              <DropdownMenuTrigger
                aria-label="More actions"
                title="More actions"
                className="tap-target relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => handlers.onOpen(item.id)}>
                  <PanelRightOpen /> Open details
                </DropdownMenuItem>
                {item.contactId && (
                  <DropdownMenuItem
                    render={<Link href={`/capture?contactId=${item.contactId}`} />}
                  >
                    <NotebookPen /> {item.actionKind === "meet" ? "Log meeting" : "Log a note"}
                  </DropdownMenuItem>
                )}
                {lists.length > 1 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Move to</DropdownMenuLabel>
                    {lists
                      .filter((l) => l.id !== item.listId)
                      .map((l) => (
                        <DropdownMenuItem key={l.id} onClick={() => handlers.onMove(item.id, l.id)}>
                          {l.isInbox !== undefined ? (
                            <ListGlyph list={{ icon: l.icon ?? null, color: l.color ?? null, isInbox: l.isInbox }} />
                          ) : (
                            <FolderInput />
                          )}{" "}
                          <span className="truncate">{l.name}</span>
                        </DropdownMenuItem>
                      ))}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => handlers.onDelete(item.id)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </li>
  );
});
