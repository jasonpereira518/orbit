"use client";

import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { groupThreadsByDay, type ThreadLike } from "@/lib/chat-history-groups";
import { Button } from "@/components/ui/button";

/**
 * The conversation list beside the chat, grouped Today / Yesterday / Earlier.
 *
 * Replaces a `History` dropdown that hid the list behind a click and showed one flat run of
 * titles. A rail keeps the whole history in view and one click from any thread, which is what
 * a chat you return to daily needs. It is desktop-only (`md:` up) on purpose: on a phone the
 * conversation deserves the full width, so there the header keeps its dropdown.
 */

export type ChatHistoryRailProps<T extends ThreadLike> = {
  threads: readonly T[];
  activeId: string | null;
  /** Locked while an answer is streaming — switching threads mid-answer would orphan it. */
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** The toggle that collapses this rail points at it with `aria-controls`. */
  id?: string;
  className?: string;
};

export function ChatHistoryRail<T extends ThreadLike>({
  threads,
  activeId,
  busy,
  onSelect,
  onNew,
  onDelete,
  id,
  className,
}: ChatHistoryRailProps<T>) {
  // A thread row is created the moment a question is sent, but only gets a title once an
  // answer lands. So an untitled row is a chat that never produced anything — a failed send,
  // a stop during retrieval, an abandoned "New chat" — and listing each one buried the real
  // conversations under a column of identical "New chat" entries. The one you are in stays
  // visible however empty it is, since it is where you are.
  const groups = useMemo(
    () => groupThreadsByDay(threads.filter((t) => t.title?.trim() || t.id === activeId)),
    [threads, activeId]
  );

  return (
    <nav
      id={id}
      aria-label="Chat history"
      className={cn("flex min-h-0 w-56 shrink-0 flex-col border-r border-border/60", className)}
    >
      <div className="shrink-0 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={onNew}
          disabled={busy}
        >
          <Plus className="size-4" />
          New chat
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Your conversations will collect here.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-3 last:mb-0">
              <h2 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.label}
              </h2>
              <ul className="space-y-0.5">
                {group.threads.map((thread) => {
                  const active = thread.id === activeId;
                  return (
                    <li key={thread.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onSelect(thread.id)}
                        disabled={busy && !active}
                        aria-current={active ? "true" : undefined}
                        className={cn(
                          "w-full rounded-lg px-2 py-1.5 pr-7 text-left text-sm leading-snug transition-colors disabled:opacity-50",
                          active
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-foreground/80 hover:bg-muted"
                        )}
                      >
                        <span className="line-clamp-2">{thread.title?.trim() || "New chat"}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete chat: ${thread.title?.trim() || "New chat"}`}
                        onClick={() => onDelete(thread.id)}
                        className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  );
}
