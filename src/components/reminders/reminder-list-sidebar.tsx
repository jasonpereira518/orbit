"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  createReminderList,
  deleteReminderList,
  renameReminderList,
} from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

export type ReminderListItem = {
  id: string;
  name: string;
  isInbox: boolean;
  pendingCount: number;
  doneCount: number;
};

export function ReminderListSidebar({
  lists,
  selectedListId,
  status,
  onSelectList,
}: {
  lists: ReminderListItem[];
  selectedListId: string | null;
  status: "pending" | "done" | "all";
  onSelectList: (listId: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

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
        onSelectList(res.value.id);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t create that list — try again?"));
      }
    });
  }

  return (
    <aside className="space-y-3">
      <div className="space-y-1">
        {lists.map((list) => {
          const count =
            status === "done"
              ? list.doneCount
              : status === "all"
                ? list.pendingCount + list.doneCount
                : list.pendingCount;
          const active = list.id === selectedListId;

          if (editingId === list.id) {
            return (
              <form
                key={list.id}
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  start(async () => {
                    try {
                      const res = await renameReminderList(list.id, editName);
                      if (!res.ok) {
                        toast.error(res.error);
                        return;
                      }
                      setEditingId(null);
                      toast.success("List renamed");
                      router.refresh();
                    } catch (err) {
                      toast.error(
                        friendlyError(err, "Couldn’t rename that list — try again?")
                      );
                    }
                  });
                }}
              >
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-8"
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={pending}>
                  Save
                </Button>
              </form>
            );
          }

          return (
            <div
              key={list.id}
              className={cn(
                "group flex items-center gap-1 rounded-lg",
                active && "bg-muted/70"
              )}
            >
              <button
                type="button"
                onClick={() => onSelectList(list.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                  active && "font-medium text-primary"
                )}
              >
                <span className="truncate">{list.name}</span>
                <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                  {count}
                </span>
              </button>
              {!list.isInbox && (
                <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Rename list"
                    onClick={() => {
                      setEditingId(list.id);
                      setEditName(list.name);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Delete list"
                    disabled={pending}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete “${list.name}”? Reminders move to Inbox.`
                        )
                      ) {
                        return;
                      }
                      start(async () => {
                        try {
                          const res = await deleteReminderList(list.id);
                          if (!res.ok) {
                            toast.error(res.error);
                            return;
                          }
                          toast.success("List deleted");
                          if (selectedListId === list.id) {
                            onSelectList(res.value.inboxId);
                          }
                          router.refresh();
                        } catch (err) {
                          toast.error(
                            friendlyError(err, TOAST_COPY.deleteFailed)
                          );
                        }
                      });
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          createList();
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New list"
          className="h-8"
        />
        <Button
          type="submit"
          size="icon-sm"
          variant="outline"
          disabled={pending || !newName.trim()}
          aria-label="Add list"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </form>
    </aside>
  );
}
