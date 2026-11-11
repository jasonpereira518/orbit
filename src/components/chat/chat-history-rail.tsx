"use client";

import { memo, useEffect, useMemo, useState, useRef } from "react";
import { motion } from "motion/react";
import { MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { groupThreadsByDay, type ThreadLike } from "@/lib/chat-history-groups";
import { RAIL_CLOSED_WIDTH, RAIL_OPEN_WIDTH } from "@/lib/chat-rail-pref";
import { EASE_HOUSE } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

// The widths live with the rail's other shared facts so the loading placeholder can match
// them without importing this component (and its menus) into every page that shows a skeleton.
export { RAIL_CLOSED_WIDTH, RAIL_OPEN_WIDTH };

/** A thread as the rail lists it: `pinnedAt` set means it leads the list under "Pinned". */
export type RailThread = ThreadLike & { pinnedAt?: Date | string | null };

/** One result of searching past conversations. `snippet` is the matching message text, if any. */
export type RailSearchHit = { id: string; title: string | null; snippet: string | null };

/** Titles are capped server-side too (`THREAD_TITLE_MAX`). */
const TITLE_MAX = 120;

export type ChatHistoryRailProps<T extends RailThread> = {
  threads: readonly T[];
  /**
   * The list has not been read yet. An empty `threads` then means "unknown", so the rail shows
   * placeholder rows instead of claiming there are no conversations.
   */
  loading?: boolean;
  /**
   * The list is a page: older threads exist past it. The server reads history a page at a
   * time (`listChatThreads`), so the end of the list is not the end of the history.
   */
  hasMore?: boolean;
  /** The next page is being read. */
  loadingMore?: boolean;
  /** Read the next (older) page and append it. */
  onLoadMore?: () => void;
  activeId: string | null;
  /** Locked while an answer is streaming — switching threads mid-answer would orphan it. */
  busy: boolean;
  /** Whether the full panel is showing; false is the slim strip. */
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Save a new name for a conversation. */
  onRename?: (id: string, title: string) => void;
  /** Pin a conversation to the top, or unpin it. */
  onPin?: (id: string, pinned: boolean) => void;
  /** Find conversations by their title or what was said in them. Absent hides the search box. */
  onSearch?: (query: string) => Promise<RailSearchHit[]>;
  /** The pointer came to rest on a row — a hint to start loading that thread. */
  onIntent?: (id: string) => void;
  /** The pointer left a row. */
  onIntentEnd?: () => void;
  /** Focus or touch reached a row: load it now. */
  onIntentNow?: (id: string) => void;
  /** The toggle points at the panel it collapses with `aria-controls`. */
  id?: string;
  className?: string;
};

function ChatHistoryRailImpl<T extends RailThread>({
  threads,
  loading = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  activeId,
  busy,
  open,
  onToggle,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onPin,
  onSearch,
  onIntent,
  onIntentEnd,
  onIntentNow,
  id,
  className,
}: ChatHistoryRailProps<T>) {
  const [query, setQuery] = useState("");
  // Results carry the query they answer, so a slower earlier search cannot show under a newer one.
  const [found, setFound] = useState<{ query: string; hits: RailSearchHit[] } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const searchFor = query.trim();
  const searchingNow = searchFor.length >= 2;

  useEffect(() => {
    if (!onSearch || searchFor.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      onSearch(searchFor).then(
        (hits) => live && setFound({ query: searchFor, hits }),
        () => live && setFound({ query: searchFor, hits: [] })
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [onSearch, searchFor]);

  // One commit per rename. The field commits on Enter AND on blur, and removing it after Enter
  // can blur it again from the same stale `renaming`: the title was saved twice. Escape counts
  // as ended too, or the blur that follows it would save the rename that was just cancelled.
  const renameEnded = useRef(false);
  const startRename = (id: string, value: string) => {
    renameEnded.current = false;
    setRenaming({ id, value });
  };
  const commitRename = () => {
    if (!renaming || renameEnded.current) return;
    renameEnded.current = true;
    const title = renaming.value.trim();
    if (title) onRename?.(renaming.id, title);
    setRenaming(null);
  };

  // A thread row is created the moment a question is sent, but only gets a title once an
  // answer lands. So an untitled row is a chat that never produced anything — a failed send,
  // a stop during retrieval, an abandoned "New chat" — and listing each one buried the real
  // conversations under a column of identical "New chat" entries. The one you are in stays
  // visible however empty it is, since it is where you are.
  //
  // `listChatThreads` already leaves untitled threads out in SQL, so what this still catches
  // is the panel's own additions (a chat just started) and a title JavaScript's `trim()`
  // empties but Postgres's `btrim()` does not (tabs, no-break spaces).
  const { pinned, groups } = useMemo(() => {
    const shown = threads.filter((t) => t.title?.trim() || t.id === activeId);
    const pinned = shown
      .filter((t) => t.pinnedAt)
      .sort((a, b) => new Date(b.pinnedAt!).getTime() - new Date(a.pinnedAt!).getTime());
    return { pinned, groups: groupThreadsByDay(shown.filter((t) => !t.pinnedAt)) };
  }, [threads, activeId]);
  const sections = [...(pinned.length ? [{ label: "Pinned", threads: pinned }] : []), ...groups];

  const renderRow = (thread: T) => {
    const active = thread.id === activeId;
    const label = thread.title?.trim() || "New chat";
    if (renaming?.id === thread.id) {
      return (
        <li key={thread.id}>
          <input
            autoFocus
            aria-label={`Rename chat: ${label}`}
            value={renaming.value}
            maxLength={TITLE_MAX}
            onChange={(e) => setRenaming({ id: thread.id, value: e.target.value })}
            onFocus={(e) => e.target.select()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                renameEnded.current = true;
                setRenaming(null);
              }
            }}
            className="w-full rounded-lg border border-ring bg-background px-2 py-1.5 text-sm leading-snug outline-none ring-2 ring-ring/20"
          />
        </li>
      );
    }
    return (
      <li key={thread.id} className="group relative">
        <button
          type="button"
          onClick={() => onSelect(thread.id)}
          onPointerEnter={onIntent ? () => onIntent(thread.id) : undefined}
          onPointerLeave={onIntentEnd}
          onFocus={onIntentNow ? () => onIntentNow(thread.id) : undefined}
          onTouchStart={onIntentNow ? () => onIntentNow(thread.id) : undefined}
          disabled={busy}
          aria-current={active ? "true" : undefined}
          className={cn(
            "w-full rounded-lg px-2 py-1.5 pr-7 text-left text-sm leading-snug transition-colors",
            active
              ? "bg-primary/10 font-medium text-primary"
              : "text-foreground/80 hover:bg-muted disabled:opacity-50"
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
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Chat options: ${label}`}
            disabled={busy}
            render={
              <button
                type="button"
                className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground pointer-fine:opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 disabled:invisible"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {onRename && (
              <DropdownMenuItem onClick={() => startRename(thread.id, label)}>Rename</DropdownMenuItem>
            )}
            {onPin && (
              <DropdownMenuItem onClick={() => onPin(thread.id, !thread.pinnedAt)}>
                {thread.pinnedAt ? "Unpin" : "Pin"}
              </DropdownMenuItem>
            )}
            {(onRename || onPin) && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(thread.id)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    );
  };

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

          {onSearch && (
            <div className="relative shrink-0 px-3 pb-2">
              <Search className="pointer-events-none absolute left-5 top-2 size-3.5 text-muted-foreground" />
              <input
                type="search"
                aria-label="Search chats"
                placeholder="Search chats"
                value={query}
                maxLength={100}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                className="h-7.5 w-full rounded-lg border border-input bg-transparent pl-7 pr-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-4 top-1 rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {searchingNow ? (
              found?.query !== searchFor ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">Searching…</p>
              ) : found.hits.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">No chats mention that.</p>
              ) : (
                <ul className="space-y-0.5" aria-label="Search results">
                  {found.hits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(hit.id)}
                        disabled={busy}
                        className={cn(
                          "w-full rounded-lg px-2 py-1.5 text-left text-sm leading-snug transition-colors hover:bg-muted disabled:opacity-50",
                          hit.id === activeId ? "bg-primary/10 text-primary" : "text-foreground/80"
                        )}
                      >
                        <span className="line-clamp-1 font-medium">{hit.title?.trim() || "New chat"}</span>
                        {hit.snippet && (
                          <span className="line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : sections.length === 0 && loading ? (
              <ChatHistoryRailSkeleton />
            ) : sections.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Your conversations will collect here.
              </p>
            ) : (
              sections.map((group) => (
                <section key={group.label} className="mb-3 last:mb-0">
                  <h2 className="flex items-center gap-1 px-2 pb-1 text-2xs font-medium text-muted-foreground">
                    {group.label === "Pinned" && <Pin className="size-3" />}
                    {group.label}
                  </h2>
                  <ul className="space-y-0.5">{group.threads.map(renderRow)}</ul>
                </section>
              ))
            )}
            {!searchingNow && hasMore && onLoadMore && groups.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 w-full text-xs text-muted-foreground"
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Show older chats"}
              </Button>
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

/** Placeholder widths, so the rows read as titles of different lengths rather than a grid. */
const SKELETON_ROW_WIDTHS = ["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-1/2", "w-3/4"];

/**
 * The list before it has been read: one day heading and a column of rows, each the height of
 * a one-line thread row (`py-1.5` around a `text-sm leading-snug` line), so the real list
 * lands without shifting what is below the fold.
 */
function ChatHistoryRailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading chat history">
      <div className="flex h-[20.5px] items-center px-2 pb-1">
        <Skeleton className="h-2 w-10 rounded-sm" />
      </div>
      <ul className="space-y-0.5">
        {SKELETON_ROW_WIDTHS.map((width) => (
          <li key={width} className="flex h-[31.25px] items-center px-2">
            <Skeleton className={cn("h-3 rounded-sm", width)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Memoised so composer keystrokes and streamed frames in the chat panel skip the rail: every
 * prop it gets is state or a stable callback. The cast keeps the generic signature, which
 * `memo` would otherwise erase.
 */
export const ChatHistoryRail = memo(ChatHistoryRailImpl) as typeof ChatHistoryRailImpl;
