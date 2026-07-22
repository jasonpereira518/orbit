"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import type { ReminderActionKind } from "@/db/schema";
import { ReminderCard } from "@/components/reminders/reminder-card";
import { ReminderCreateForm } from "@/components/reminders/reminder-create-form";
import {
  ReminderListSidebar,
  type ReminderListItem,
} from "@/components/reminders/reminder-list-sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ReminderPageItem = {
  id: string;
  title: string;
  description: string | null;
  dueDate: Date | string | null;
  status: string;
  reminderType: string;
  actionKind: ReminderActionKind;
  listId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

export function RemindersView({
  lists,
  selectedListId,
  status,
  reminders,
}: {
  lists: ReminderListItem[];
  selectedListId: string | null;
  status: "pending" | "done" | "all";
  reminders: ReminderPageItem[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateParams = useCallback(
    (patch: { list?: string | null; status?: string }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (patch.list !== undefined) {
        if (patch.list) params.set("list", patch.list);
        else params.delete("list");
      }
      if (patch.status !== undefined) {
        if (patch.status && patch.status !== "pending") {
          params.set("status", patch.status);
        } else {
          params.delete("status");
        }
      }
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams]
  );

  const listOptions = lists.map((l) => ({ id: l.id, name: l.name }));

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <div className="space-y-4">
        <ReminderListSidebar
          lists={lists}
          selectedListId={selectedListId}
          status={status}
          onSelectList={(id) => updateParams({ list: id })}
        />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1 rounded-lg border border-border/60 p-0.5">
            {(
              [
                ["pending", "Active"],
                ["done", "Done"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7",
                  status === value && "bg-muted font-medium"
                )}
                onClick={() => updateParams({ status: value })}
              >
                {label}
              </Button>
            ))}
          </div>
          <ReminderCreateForm listId={selectedListId} lists={listOptions} />
        </div>

        {reminders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {status === "done"
                ? "No completed reminders in this list."
                : "Nothing here yet. Add a reminder to get started."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {reminders.map((r) => (
              <ReminderCard
                key={r.id}
                id={r.id}
                title={r.title}
                description={r.description}
                dueDate={r.dueDate}
                reminderType={r.reminderType}
                actionKind={r.actionKind}
                contactId={r.contactId}
                contactName={r.contactName}
                contactEmail={r.contactEmail}
                contactPhone={r.contactPhone}
                listId={r.listId}
                lists={listOptions}
                showListMove
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
