"use client";

import { useState } from "react";
import { ReminderFormFields } from "@/components/reminders/reminder-form-dialog";
import { buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function ReminderCreateForm({
  listId,
  lists,
}: {
  listId: string | null;
  lists: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        className={cn(buttonVariants(), "h-8")}
      >
        New reminder
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
          idPrefix="reminder-create"
        />
      </PopoverContent>
    </Popover>
  );
}
