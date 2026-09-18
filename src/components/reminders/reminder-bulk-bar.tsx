"use client";

import { Check, FolderInput, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReminderSnoozeMenu } from "@/components/reminders/reminder-snooze-menu";
import { cn } from "@/lib/utils";

const BAR_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/**
 * Select-all and the bulk actions for a selection.
 *
 * It reserves its height whether or not anything is selected (as the admin interest-list
 * table does): a bar that pops in shifts the first row down exactly as someone is reaching
 * for the second checkbox.
 */
export function ReminderBulkBar({
  count,
  visibleCount,
  allVisibleSelected,
  onToggleAll,
  onClear,
  canAct,
  today,
  lists,
  busy,
  snoozeOpen,
  onSnoozeOpenChange,
  moveOpen,
  onMoveOpenChange,
  onDone,
  onSnooze,
  onMove,
  onDelete,
  summary,
}: {
  count: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  /** False in Done, where done/snooze make no sense. */
  canAct: boolean;
  today: string;
  lists: Array<{ id: string; name: string }>;
  busy: boolean;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
  moveOpen: boolean;
  onMoveOpenChange: (open: boolean) => void;
  onDone: () => void;
  onSnooze: (ymd: string, label: string) => void;
  onMove: (listId: string, name: string) => void;
  onDelete: () => void;
  /** Shown when nothing is selected: the view's count. */
  summary: React.ReactNode;
}) {
  const selecting = count > 0;
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-3 sm:px-4">
      <div className="flex h-6 w-4 items-center">
        <Checkbox
          checked={allVisibleSelected && visibleCount > 0}
          indeterminate={selecting && !allVisibleSelected}
          disabled={visibleCount === 0}
          onCheckedChange={onToggleAll}
          aria-label={allVisibleSelected ? "Deselect all" : "Select all shown"}
        />
      </div>
      {selecting ? (
        <>
          <span className="ml-2 mr-1 shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-foreground" aria-live="polite">
            {count} selected
          </span>
          {canAct && (
            <button type="button" className={BAR_BUTTON} onClick={onDone} disabled={busy}>
              <Check className="size-3.5" /> Done
            </button>
          )}
          {canAct && (
            <ReminderSnoozeMenu
              today={today}
              open={snoozeOpen}
              onOpenChange={onSnoozeOpenChange}
              onPick={onSnooze}
              triggerLabel="Snooze"
              align="start"
              disabled={busy}
            />
          )}
          {lists.length > 1 && (
            <DropdownMenu open={moveOpen} onOpenChange={onMoveOpenChange}>
              <DropdownMenuTrigger className={BAR_BUTTON} disabled={busy}>
                <FolderInput className="size-3.5" /> Move
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>Move {count} to</DropdownMenuLabel>
                {lists.map((l) => (
                  <DropdownMenuItem key={l.id} onClick={() => onMove(l.id, l.name)}>
                    <span className="truncate">{l.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button
            type="button"
            className={cn(BAR_BUTTON, "hover:text-destructive")}
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 className="size-3.5" /> Delete
          </button>
          <div className="flex-1" />
          <Button variant="ghost" size="icon-xs" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
            <X className="size-3.5" />
          </Button>
        </>
      ) : (
        <div className="ml-2 flex min-w-0 flex-1 items-center text-xs text-muted-foreground">{summary}</div>
      )}
    </div>
  );
}
