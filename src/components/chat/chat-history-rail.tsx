"use client";

import { memo, useMemo } from "react";
import { motion } from "motion/react";
import { PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { groupThreadsByDay, type ThreadLike } from "@/lib/chat-history-groups";
import { EASE_HOUSE } from "@/lib/motion";
import { Button } from "@/components/ui/button";

/**
 * The conversation list beside the chat, grouped Today / Yesterday / Earlier.
 *
 * It collapses from inside itself. The toggle sits at the top of the panel it controls,
 * and a closed panel is not gone — it narrows to a slim strip that keeps the expand button
 * (and a new-chat button), so the way back is always where the panel was rather than in
 * some other part of the page.
 *
 * Both layouts stay mounted and cross-fade while the width animates, rather than swapping:
 * a swap while the panel is mid-resize shows one layout squashed into the other's width.
 * Whichever is hidden is `inert`, so it is out of the tab order and unreachable, not just
 * invisible.
 *
 * Desktop-only (`md:` up) on purpose: on a phone the conversation deserves the full width, so
 * there the header keeps a history dropdown.
 */

/** Wide enough for a title to wrap to two lines; the strip is just room for one icon button. */
export const RAIL_OPEN_WIDTH = 224;
export const RAIL_CLOSED_WIDTH = 48;

export type ChatHistoryRailProps<T extends ThreadLike> = {
  threads: readonly T[];
  activeId: string | null;
  /** Locked while an answer is streaming — switching threads mid-answer would orphan it. */
  busy: boolean;
  /** Whether the full panel is showing; false is the slim strip. */
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** The toggle points at the panel it collapses with `aria-controls`. */
  id?: string;
  className?: string;
};

function ChatHistoryRailImpl<T extends ThreadLike>({
  threads,
  activeId,
  busy,
  open,
  onToggle,
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
    <motion.div
      className={cn("hidden shrink-0 overflow-hidden border-r border-border/60 md:block", className)}
      initial={false}
      animate={{ width: open ? RAIL_OPEN_WIDTH : RAIL_CLOSED_WIDTH }}
      transition={{ duration: 0.22, ease: EASE_HOUSE }}
    >
      <nav id={id} aria-label="Chat history" className="relative h-full">
        {/* ── Open: the full panel ─────────────────────────────────────────────── */}
        <div
          inert={!open}
          className={cn(
            "absolute inset-y-0 left-0 flex flex-col transition-opacity duration-150",
            open ? "opacity-100" : "pointer-events-none opacity-0"
          )}
          style={{ width: RAIL_OPEN_WIDTH }}
        >
          <div className="flex shrink-0 items-center gap-1.5 p-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-0 flex-1 justify-start gap-2"
              onClick={onNew}
              disabled={busy}
            >
              <Plus className="size-4" />
              New chat
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              onClick={onToggle}
              aria-expanded={true}
              aria-controls={id}
              aria-label="Hide chat history"
              title="Hide chat history"
            >
              <PanelLeftClose className="size-4" />
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
                      const label = thread.title?.trim() || "New chat";
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
                            {/* Keyed on the label so a chat's name fades in when its summary
                                arrives, rather than the row's text changing under the eye. */}
                            <motion.span
                              key={label}
                              className="line-clamp-2"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              transition={{ duration: 0.25 }}
                            >
                              {label}
                            </motion.span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete chat: ${label}`}
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
        </div>

        {/* ── Closed: the strip ────────────────────────────────────────────────── */}
        <div
          inert={open}
          className={cn(
            "absolute inset-y-0 left-0 flex flex-col items-center gap-1 py-3 transition-opacity duration-150",
            open ? "pointer-events-none opacity-0" : "opacity-100"
          )}
          style={{ width: RAIL_CLOSED_WIDTH }}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onToggle}
            aria-expanded={false}
            aria-controls={id}
            aria-label="Show chat history"
            title="Show chat history"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onNew}
            disabled={busy}
            aria-label="New chat"
            title="New chat"
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </nav>
    </motion.div>
  );
}

/**
 * Memoised so composer keystrokes and streamed frames in the chat panel skip the rail: every
 * prop it gets is state or a stable callback. The cast keeps the generic signature, which
 * `memo` would otherwise erase.
 */
export const ChatHistoryRail = memo(ChatHistoryRailImpl) as typeof ChatHistoryRailImpl;
