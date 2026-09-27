"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { ReminderFormFields } from "@/components/reminders/reminder-form-dialog";
import { buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * "New reminder" in a popover. Controlled when `open` is passed, so the reminders queue's
 * `c` shortcut can open it; uncontrolled otherwise.
 */
export function ReminderCreateForm({
  listId,
  lists,
  open: openProp,
  onOpenChange,
  compactTrigger = false,
  defaultDue,
}: {
  listId: string | null;
  lists: Array<{ id: string; name: string }>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Icon-only below `sm`, where the toolbar has no room for the label. */
  compactTrigger?: boolean;
  /** YYYY-MM-DD to prefill — today, when created from the Today view. */
  defaultDue?: string | null;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  // Memoized: the form re-initializes whenever `initial` changes identity.
  const initial = useMemo(() => (defaultDue ? { dueDate: defaultDue } : null), [defaultDue]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="New reminder"
        title="New reminder (c)"
        className={cn(buttonVariants(), "h-8 shrink-0 gap-1.5", compactTrigger && "max-sm:size-8 max-sm:px-0")}
      >
        <Plus className="size-4" />
        <span className={cn(compactTrigger && "max-sm:sr-only")}>New reminder</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[min(calc(100vw-2rem),28rem)] rounded-xl border border-border/70 bg-card p-4 shadow-lg ring-0"
      >
        <div className="mb-3">
          <p className="font-heading text-base font-medium">New reminder</p>
        </div>
        <ReminderFormFields
          open={open}
          onClose={() => setOpen(false)}
          mode="create"
          lists={lists}
          defaultListId={listId}
          initial={initial}
          idPrefix="reminder-create"
        />
      </PopoverContent>
    </Popover>
  );
}
