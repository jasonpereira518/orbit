"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { ListFilter, Loader2 } from "lucide-react";
import {
  bulkReminderAction,
  deleteReminderAction,
  loadRemindersPage,
  markReminderDone,
  reopenDoneReminderAction,
  reopenReminderAction,
  rescheduleReminderAction,
  restoreReminderAction,
  undoBulkReminderAction,
  unsnoozeReminderAction,
  type BulkReminderOp,
} from "@/actions/reminders";
import type { SuggestedReminderRow } from "@/actions/suggested-reminders";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ReminderBulkBar } from "@/components/reminders/reminder-bulk-bar";
import { ReminderCreateForm } from "@/components/reminders/reminder-create-form";
import { ReminderDetailPane } from "@/components/reminders/reminder-detail-pane";
import { ReminderFilters, type QueueFilters } from "@/components/reminders/reminder-filters";
import { ReminderRail, type RailTarget } from "@/components/reminders/reminder-rail";
import type { CalendarSyncSummary } from "@/components/reminders/reminder-calendar-sync";
import { ListGlyph } from "@/components/reminders/list-glyph";
import { ReminderRow, type ReminderRowHandlers } from "@/components/reminders/reminder-row";
import { RemindersShortcutsHelp } from "@/components/reminders/reminders-shortcuts-help";
import { SuggestedRemindersPanel } from "@/components/reminders/suggested-reminders-panel";
import { useMediaQuery, useTriageKeys } from "@/components/reminders/use-triage-keys";
import { DUR_MS } from "@/lib/motion";
import {
  bucketForDay,
  DUE_BUCKET_LABELS,
  resolveTimeZone,
  TZ_COOKIE,
  type DueBucket,
} from "@/lib/reminder-due-bucket";
import type {
  ReminderListSummary,
  ReminderRailCounts,
  ReminderRow as ReminderRowData,
  RemindersPage,
} from "@/lib/reminders-page";
import { isQueuedOffline } from "@/lib/offline-queue-store";
import { runToastAction } from "@/lib/toast";
import type { TriageCommand } from "@/lib/triage-keys";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 250;
/** Where the detail pane sits inline rather than in a sheet: Tailwind's `xl`. */
const INLINE_DETAIL_QUERY = "(min-width: 80rem)";

const VIEW_TITLES: Record<string, string> = {
  today: "Today",
  upcoming: "Upcoming",
  anytime: "Anytime",
  done: "Done",
  suggested: "Suggested from your notes",
};

const EMPTY_COPY: Record<string, { title: string; body: string }> = {
  today: { title: "Nothing due today", body: "You’re clear. Upcoming has what’s next." },
  upcoming: { title: "Nothing scheduled ahead", body: "Reminders with a future date land here." },
  anytime: { title: "No undated reminders", body: "Reminders without a due date collect here." },
  done: { title: "Nothing done yet", body: "Reminders you mark done show up here." },
  list: { title: "This list is empty", body: "Add a reminder, or move some here from another view." },
};

type Group = { bucket: DueBucket | null; items: ReminderRowData[] };

/** Grouped by due bucket in time-ordered views; one flat group in Done. */
function groupItems(items: ReminderRowData[], today: string, flat: boolean): Group[] {
  if (flat) return [{ bucket: null, items }];
  const groups: Group[] = [];
  for (const item of items) {
    const bucket = bucketForDay(item.dueDay, today);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.items.push(item);
    else groups.push({ bucket, items: [item] });
  }
  return groups;
}

function writeTimeZoneCookie(tz: string) {
  document.cookie = `${TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
}

function readTimeZoneCookie() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${TZ_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The reminders page: rail | queue | detail.
 *
 * Owns the queue's client state — the loaded pages, selection, roving focus, which row's
 * menus are open, and the optimistic exits — and drives the URL for everything that
 * describes WHAT is shown (view, list, search, chips), so a view is linkable and Back works.
 * What is selected or focused stays local: pushing it into the URL would re-run the page's
 * server work on every keystroke.
 */
export function RemindersStage({
  target,
  counts,
  lists,
  inboxId,
  page,
  filters: urlFilters,
  suggested,
  openCreate = false,
  calendar,
}: {
  target: RailTarget;
  counts: ReminderRailCounts;
  lists: ReminderListSummary[];
  inboxId: string | null;
  page: RemindersPage;
  filters: QueueFilters;
  suggested: SuggestedReminderRow[] | null;
  /** Arrived from the palette's "New reminder". */
  openCreate?: boolean;
  calendar?: CalendarSyncSummary;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNav] = useTransition();
  const inlineDetail = useMediaQuery(INLINE_DETAIL_QUERY);

  // ── Timezone: the server decides "today" from a cookie only the browser can write. ──
  useEffect(() => {
    const tz = resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (readTimeZoneCookie() !== tz) {
      writeTimeZoneCookie(tz);
      router.refresh();
    }
  }, [router]);

  // ── Loaded rows. Re-synced from the server's page during render, not in an effect, so a
  // refresh never paints the stale list first (the contacts list's pattern). ──
  const [items, setItems] = useState(page.items);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [syncedFrom, setSyncedFrom] = useState(page);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  if (syncedFrom !== page) {
    setSyncedFrom(page);
    setItems(page.items);
    setCursor(page.nextCursor);
    setLoadError(false);
  }
  const today = page.today;

  // ── Selection, focus, open panels. ──
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [exiting, setExiting] = useState<Set<string>>(() => new Set());
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [moreFor, setMoreFor] = useState<string | null>(null);
  const [bulkSnoozeOpen, setBulkSnoozeOpen] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [paneSnoozeOpen, setPaneSnoozeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(openCreate);
  // The palette can send ?new=1 while this page is already mounted, when an initial state
  // alone would never see it. Opens on the prop's rising edge.
  const [openCreateSeen, setOpenCreateSeen] = useState(openCreate);
  if (openCreateSeen !== openCreate) {
    setOpenCreateSeen(openCreate);
    if (openCreate) setCreateOpen(true);
  }
  const [helpOpen, setHelpOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  // Stable, so `ReminderRow`'s memo holds; each row wraps it in its own stable ref callback.
  // Same effect on `rowRefs` as the old inline callback: set on attach, deleted on detach
  // (including unmount).
  const registerRow = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // A new view or filter set starts clean. Keyed on what is SHOWN, so a refresh of the
  // same view (after a mutation) keeps selection and focus.
  const viewKey = [
    target.kind === "list" ? `list:${target.id}` : target.view,
    urlFilters.q,
    urlFilters.kinds.join(","),
    urlFilters.sources.join(","),
    urlFilters.contact?.id ?? "",
  ].join("|");
  const [viewKeySeen, setViewKeySeen] = useState(viewKey);
  if (viewKeySeen !== viewKey) {
    setViewKeySeen(viewKey);
    setSelected(new Set());
    setAnchorId(null);
    setFocusedId(null);
    setDetailId(null);
    setExiting(new Set());
  }

  const visible = useMemo(() => items.filter((i) => !exiting.has(i.id)), [items, exiting]);
  const detailItem = detailId ? items.find((i) => i.id === detailId) ?? null : null;
  const listOptions = useMemo(
    () => lists.map((l) => ({ id: l.id, name: l.name, icon: l.icon, color: l.color, isInbox: l.isInbox })),
    [lists]
  );
  const isDoneView = target.kind === "view" && target.view === "done";
  const isSuggested = target.kind === "view" && target.view === "suggested";
  const currentListId = target.kind === "list" ? target.id : null;
  const currentList = currentListId ? lists.find((l) => l.id === currentListId) ?? null : null;

  // ── Search box: local while typing, written to the URL after a pause. ──
  const [qDraft, setQDraft] = useState(urlFilters.q);
  const [qSyncedFrom, setQSyncedFrom] = useState(urlFilters.q);
  if (qSyncedFrom !== urlFilters.q) {
    setQSyncedFrom(urlFilters.q);
    setQDraft(urlFilters.q);
  }
  const qTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (qTimer.current) window.clearTimeout(qTimer.current);
  }, []);

  const buildHref = useCallback(
    (next: { target?: RailTarget; filters?: Partial<QueueFilters> }) => {
      const t = next.target ?? target;
      const f = { ...urlFilters, ...next.filters };
      const params = new URLSearchParams();
      if (t.kind === "list") params.set("list", t.id);
      else if (t.view !== "today") params.set("view", t.view);
      if (f.q.trim()) params.set("q", f.q.trim());
      if (f.kinds.length) params.set("kind", f.kinds.join(","));
      if (f.sources.length) params.set("source", f.sources.join(","));
      if (f.contact) params.set("contact", f.contact.id);
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, target, urlFilters]
  );

  function selectTarget(next: RailTarget) {
    setRailOpen(false);
    // Moving between views is navigation (Back returns); a view's own filters carry over.
    startNav(() => router.push(buildHref({ target: next })));
  }

  function changeFilters(patch: Partial<QueueFilters>) {
    startNav(() => router.replace(buildHref({ filters: patch })));
  }

  function changeQuery(q: string) {
    setQDraft(q);
    if (qTimer.current) window.clearTimeout(qTimer.current);
    if (!q.trim()) {
      changeFilters({ q: "" });
      return;
    }
    qTimer.current = window.setTimeout(() => changeFilters({ q }), SEARCH_DEBOUNCE_MS);
  }

  // ── Paging. ──
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || loadError || isSuggested) return;
    setLoadingMore(true);
    try {
      const next = await loadRemindersPage({
        view: target.kind === "view" && target.view !== "suggested" ? target.view : null,
        listId: currentListId,
        q: urlFilters.q,
        kinds: urlFilters.kinds,
        sources: urlFilters.sources,
        contactId: urlFilters.contact?.id ?? null,
        cursor,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...next.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(next.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, loadError, isSuggested, target, currentListId, urlFilters]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollerRef.current;
    if (!el || !root || !cursor) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root, rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  // ── Focus. ──
  const focusRow = useCallback((id: string | null) => {
    setFocusedId(id);
    if (!id) return;
    // After the render that makes it tabbable.
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  /** Where focus goes when `ids` leave the list: the next survivor, else the previous. */
  function successorOf(ids: Set<string>) {
    const anchor = focusedId && ids.has(focusedId) ? focusedId : null;
    if (!anchor) return focusedId;
    const idx = visible.findIndex((i) => i.id === anchor);
    for (let i = idx + 1; i < visible.length; i++) if (!ids.has(visible[i].id)) return visible[i].id;
    for (let i = idx - 1; i >= 0; i--) if (!ids.has(visible[i].id)) return visible[i].id;
    return null;
  }

  // ── Mutations. Rows that will leave this view collapse first, then the action runs; a
  // failure puts them back exactly as they were on screen. ──
  function exitThen(ids: string[], leaves: boolean, run: () => Promise<boolean>) {
    const idSet = new Set(ids);
    if (!leaves) {
      void run();
      return;
    }
    const nextFocus = successorOf(idSet);
    setExiting((prev) => new Set([...prev, ...ids]));
    if (detailId && idSet.has(detailId)) setDetailId(null);
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    if (nextFocus !== focusedId) focusRow(nextFocus);

    window.setTimeout(() => {
      let restore: ReminderRowData[] = [];
      setItems((prev) => {
        restore = prev;
        return prev.filter((i) => !idSet.has(i.id));
      });
      setExiting((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      void run().then((ok) => {
        if (!ok) setItems(restore);
      });
    }, DUR_MS.slow);
  }

  const refresh = () => router.refresh();

  function leavesOnSnooze(ymd: string) {
    if (target.kind === "list") return false;
    if (target.view === "today") return ymd > today;
    return target.view === "anytime";
  }

  function doneOne(id: string) {
    return (
      exitThen([id], !isDoneView, async () => {
        const res = await runToastAction({
          run: () => markReminderDone(id),
          success: "Marked done",
          failure: "Couldn’t mark that done — try again?",
          refresh,
          undo: (snap) => (snap ? () => reopenReminderAction(snap) : null),
          offline: { kind: "reminder.done", args: [id], subject: id },
        });
        refresh();
        // Queued offline counts as done here: the row stays gone, and the sync on
        // reconnect makes it true.
        return res !== undefined || isQueuedOffline(id);
      })
    );
  }

  function reopenOne(id: string) {
    return exitThen([id], isDoneView, async () => {
      const res = await runToastAction({
        run: () => reopenDoneReminderAction(id),
        success: "Reopened",
        failure: "Couldn’t reopen that — try again?",
        refresh,
        undo: (snap) => (snap ? () => markReminderDone(id) : null),
      });
      refresh();
      return res !== undefined;
    });
  }

  function snoozeOne(id: string, ymd: string, label: string) {
    return (
      exitThen([id], leavesOnSnooze(ymd), async () => {
        const res = await runToastAction({
          run: () => rescheduleReminderAction(id, ymd),
          success: `Snoozed until ${label}`,
          failure: "Couldn’t snooze that — try again?",
          refresh,
          undo: (snap) => (snap ? () => unsnoozeReminderAction(snap) : null),
          offline: { kind: "reminder.reschedule", args: [id, ymd], subject: id },
        });
        refresh();
        return res !== undefined || isQueuedOffline(id);
      })
    );
  }

  function deleteOne(id: string) {
    return (
      exitThen([id], true, async () => {
        const res = await runToastAction({
          run: () => deleteReminderAction(id),
          success: "Reminder deleted",
          failure: "Couldn’t delete that — try again?",
          refresh,
          undo: (snap) => (snap ? () => restoreReminderAction(snap) : null),
          undone: "Reminder restored",
        });
        refresh();
        return res !== undefined;
      })
    );
  }

  function runBulk(ids: string[], op: BulkReminderOp, leaves: boolean, success: (n: number) => string) {
    setBusy(true);
    exitThen(ids, leaves, async () => {
      const res = await runToastAction({
        run: async () => {
          const result = await bulkReminderAction(ids, op);
          if (!result.ok) throw new Error(result.error);
          return result.value;
        },
        success: (v) => success(v.count),
        failure: "Couldn’t update those — try again?",
        refresh,
        undo: (v) => (v.count > 0 ? () => undoBulkReminderAction(v.snapshot) : null),
      });
      setBusy(false);
      refresh();
      return res !== undefined;
    });
  }

  function moveOne(id: string, listId: string) {
    const name = lists.find((l) => l.id === listId)?.name ?? "that list";
    runBulk([id], { op: "move", listId }, currentListId !== null && currentListId !== listId, () => `Moved to ${name}`);
  }

  const selectedIds = useMemo(() => visible.filter((i) => selected.has(i.id)).map((i) => i.id), [visible, selected]);
  const plural = (n: number) => `${n} reminder${n === 1 ? "" : "s"}`;

  function bulkDone() {
    runBulk(selectedIds, { op: "done" }, !isDoneView, (n) => `Marked ${plural(n)} done`);
  }
  function bulkSnooze(ymd: string, label: string) {
    runBulk(selectedIds, { op: "snooze", ymd }, leavesOnSnooze(ymd), (n) => `Snoozed ${plural(n)} until ${label}`);
  }
  function bulkMove(listId: string, name: string) {
    runBulk(selectedIds, { op: "move", listId }, currentListId !== null && currentListId !== listId, (n) => `Moved ${plural(n)} to ${name}`);
  }
  function bulkDelete() {
    runBulk(selectedIds, { op: "delete" }, true, (n) => `Deleted ${plural(n)}`);
  }

  // ── Selection. Shift extends from the last toggled row, as in a mail client. ──
  function toggleSelect(id: string, range: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && anchorId) {
        const a = visible.findIndex((i) => i.id === anchorId);
        const b = visible.findIndex((i) => i.id === id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(visible[i].id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchorId(id);
  }

  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));
  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((i) => i.id)));
  }

  function openDetail(id: string) {
    setDetailId((current) => (current === id && inlineDetail ? null : id));
  }

  // Row handlers that never change identity, so `ReminderRow`'s memo holds while the
  // queue re-renders: each forwards to the latest render's function through a ref.
  const live = useRef({ doneOne, reopenOne, snoozeOne, deleteOne, moveOne, toggleSelect, openDetail });
  useLayoutEffect(() => {
    live.current = { doneOne, reopenOne, snoozeOne, deleteOne, moveOne, toggleSelect, openDetail };
  });
  const handlers: ReminderRowHandlers = useMemo(
    () => ({
      onFocusRow: setFocusedId,
      onOpen: (id) => live.current.openDetail(id),
      onToggleSelect: (id, range) => live.current.toggleSelect(id, range),
      onDone: (id) => live.current.doneOne(id),
      onReopen: (id) => live.current.reopenOne(id),
      onSnooze: (id, ymd, label) => live.current.snoozeOne(id, ymd, label),
      onDelete: (id) => live.current.deleteOne(id),
      onMove: (id, listId) => live.current.moveOne(id, listId),
      onSnoozeOpenChange: (id, open) => setSnoozeFor(open ? id : null),
      onMoreOpenChange: (id, open) => setMoreFor(open ? id : null),
    }),
    []
  );

  // ── Keyboard. ──
  useTriageKeys((command: TriageCommand) => {
    if (isSuggested) {
      if (command === "search") searchRef.current?.focus();
      if (command === "help") setHelpOpen(true);
      return;
    }
    const idx = focusedId ? visible.findIndex((i) => i.id === focusedId) : -1;
    const current = idx >= 0 ? visible[idx] : null;
    const hasSelection = selectedIds.length > 0;
    switch (command) {
      case "next":
        focusRow(visible[Math.min(visible.length - 1, idx + 1)]?.id ?? null);
        if (idx + 1 >= visible.length - 5) void loadMore();
        break;
      case "prev":
        focusRow(visible[Math.max(0, idx - 1)]?.id ?? visible[0]?.id ?? null);
        break;
      case "toggleSelect":
        if (current) toggleSelect(current.id, false);
        break;
      case "open":
        if (current) setDetailId(current.id);
        break;
      case "close":
        if (detailId) setDetailId(null);
        else if (hasSelection) setSelected(new Set());
        break;
      case "done":
        if (isDoneView) break;
        if (hasSelection) bulkDone();
        else if (current) doneOne(current.id);
        break;
      case "snooze":
        if (isDoneView) break;
        if (hasSelection) setBulkSnoozeOpen(true);
        else if (current) setSnoozeFor(current.id);
        break;
      case "move":
        if (hasSelection) setBulkMoveOpen(true);
        else if (current) setMoreFor(current.id);
        break;
      case "delete":
        if (hasSelection) bulkDelete();
        else if (current) deleteOne(current.id);
        break;
      case "search":
        searchRef.current?.focus();
        break;
      case "create":
        setCreateOpen(true);
        break;
      case "help":
        setHelpOpen(true);
        break;
    }
  });

  // ── Render. ──
  const title =
    target.kind === "list"
      ? lists.find((l) => l.id === target.id)?.name ?? "List"
      : VIEW_TITLES[target.view];
  const filtered =
    Boolean(urlFilters.q) || urlFilters.kinds.length > 0 || urlFilters.sources.length > 0 || Boolean(urlFilters.contact);
  const groups = groupItems(items, today, isDoneView);
  const empty =
    EMPTY_COPY[target.kind === "list" ? "list" : target.view] ?? EMPTY_COPY.today;
  const defaultDue = target.kind === "view" && target.view === "today" ? today : null;
  const total = page.total ?? items.length;

  const detailPane = detailItem ? (
    <ReminderDetailPane
      key={detailItem.id}
      item={detailItem}
      today={today}
      lists={listOptions}
      onClose={() => {
        setDetailId(null);
        if (focusedId) focusRow(focusedId);
      }}
      onDone={doneOne}
      onReopen={reopenOne}
      onSnooze={snoozeOne}
      onDelete={deleteOne}
      snoozeOpen={paneSnoozeOpen}
      onSnoozeOpenChange={setPaneSnoozeOpen}
    />
  ) : null;

  return (
    <div data-fill-route data-clear-floating-controls className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* Calendar sync lives at the foot of the rail now, with its status. */}
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Reminders</h1>
        <div className="flex items-center gap-1">
          <RemindersShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 xl:gap-5">
        <aside className="hidden w-52 shrink-0 overflow-y-auto overscroll-contain pb-4 lg:block">
          <ReminderRail counts={counts} lists={lists} target={target} onSelect={selectTarget} calendar={calendar} />
        </aside>

        <section
          aria-labelledby="reminders-queue-title"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card"
        >
          <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 p-3 sm:p-4">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 lg:hidden"
                onClick={() => setRailOpen(true)}
                aria-label={`Views and lists — showing ${title}`}
              >
                <ListFilter className="size-3.5" />
                <span className="max-w-28 truncate">{title}</span>
                {counts.overdue > 0 && (
                  <span className="size-1.5 rounded-full bg-amber-500" title={`${counts.overdue} overdue`} />
                )}
              </Button>
              <h2
                id="reminders-queue-title"
                className="hidden min-w-0 flex-1 items-center gap-2 font-heading text-lg font-medium lg:flex"
              >
                {currentList && <ListGlyph list={currentList} className="size-4.5 shrink-0" />}
                <span className="truncate">{title}</span>
              </h2>
              <div className="flex-1 lg:hidden" />
              <ReminderCreateForm
                listId={currentListId ?? inboxId}
                lists={listOptions}
                open={createOpen}
                onOpenChange={(open) => {
                  setCreateOpen(open);
                  // Drop the palette's ?new=1 once it has done its job, so a reload or Back
                  // doesn't reopen the form. A router navigation, not history.replaceState,
                  // which would drop the create action queued behind it.
                  if (!open && openCreate) startNav(() => router.replace(buildHref({})));
                }}
                compactTrigger
                defaultDue={defaultDue}
              />
            </div>
            {!isSuggested && (
              <ReminderFilters
                ref={searchRef}
                filters={{ ...urlFilters, q: qDraft }}
                onQChange={changeQuery}
                onChange={changeFilters}
              />
            )}
          </div>

          {isSuggested ? (
            <div className="min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain p-3 sm:p-4">
              <SuggestedRemindersPanel items={suggested ?? []} embedded />
            </div>
          ) : (
            <>
              <ReminderBulkBar
                count={selectedIds.length}
                visibleCount={visible.length}
                allVisibleSelected={allVisibleSelected}
                onToggleAll={toggleAll}
                onClear={() => setSelected(new Set())}
                canAct={!isDoneView}
                today={today}
                lists={listOptions}
                busy={busy}
                snoozeOpen={bulkSnoozeOpen}
                onSnoozeOpenChange={setBulkSnoozeOpen}
                moveOpen={bulkMoveOpen}
                onMoveOpenChange={setBulkMoveOpen}
                onDone={bulkDone}
                onSnooze={bulkSnooze}
                onMove={bulkMove}
                onDelete={bulkDelete}
                summary={
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">
                      {total} {total === 1 ? "reminder" : "reminders"}
                      {filtered ? " match" : ""}
                    </span>
                    {navigating && <Loader2 className="size-3 animate-spin" aria-label="Loading" />}
                  </span>
                }
              />
              <div
                ref={scrollerRef}
                className={cn(
                  "min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain transition-opacity duration-fast",
                  navigating && "opacity-60"
                )}
              >
                {items.length === 0 ? (
                  <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 px-6 text-center">
                    <p className="font-medium">{filtered ? "No reminders match" : empty.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {filtered ? "Try a different search, or clear the filters." : empty.body}
                    </p>
                    {filtered && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                          setQDraft("");
                          changeFilters({ q: "", kinds: [], sources: [], contact: null });
                        }}
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                ) : (
                  groups.map((group, groupIndex) => (
                    <div key={group.bucket ?? "all"} role="group" aria-labelledby={group.bucket ? `bucket-${group.bucket}` : undefined}>
                      {group.bucket && (
                        <h3
                          id={`bucket-${group.bucket}`}
                          className={cn(
                            "sticky top-0 z-10 flex items-center gap-2 border-b border-border/50 bg-card/95 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide backdrop-blur-sm sm:px-4",
                            group.bucket === "overdue" ? "text-amber-700 dark:text-warning" : "text-muted-foreground"
                          )}
                        >
                          {DUE_BUCKET_LABELS[group.bucket]}
                          <span className="tabular-nums opacity-70">
                            {group.items.length}
                            {/* Only what's loaded so far; the last group may continue on the
                                next page, so it doesn't claim to be the whole count. */}
                            {cursor && groupIndex === groups.length - 1 ? "+" : ""}
                          </span>
                        </h3>
                      )}
                      <ul
                        aria-keyshortcuts="j k ArrowDown ArrowUp x e s m # Delete Enter Escape"
                        className="divide-y divide-border/40"
                      >
                        {group.items.map((item) => (
                          <ReminderRow
                            key={item.id}
                            item={item}
                            today={today}
                            lists={listOptions}
                            selected={selected.has(item.id)}
                            focused={focusedId ? focusedId === item.id : item.id === visible[0]?.id}
                            active={detailId === item.id}
                            exiting={exiting.has(item.id)}
                            snoozeOpen={snoozeFor === item.id}
                            moreOpen={moreFor === item.id}
                            handlers={handlers}
                            registerRow={registerRow}
                          />
                        ))}
                      </ul>
                    </div>
                  ))
                )}
                {cursor && (
                  <div ref={sentinelRef} className="flex justify-center py-4">
                    {loadError ? (
                      <Button variant="outline" size="sm" onClick={() => { setLoadError(false); void loadMore(); }}>
                        Couldn’t load more — retry
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                        {loadingMore ? "Loading…" : "Load more"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {/* Inline on wide screens only. Rendered for every width and hidden by CSS below xl,
            so the server's markup and the first client paint agree. */}
        {detailPane && (
          <aside
            aria-label="Reminder details"
            className="hidden w-[22rem] shrink-0 overflow-hidden rounded-2xl border border-border/70 bg-card xl:flex xl:flex-col"
          >
            {inlineDetail ? detailPane : null}
          </aside>
        )}
      </div>

      <Sheet open={railOpen} onOpenChange={setRailOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto p-4">
          {/* Visible, so the sheet's close button has a row of its own rather than sitting
              on Today's count. */}
          <SheetTitle className="mb-3 pr-8 text-base font-medium">Views and lists</SheetTitle>
          <ReminderRail counts={counts} lists={lists} target={target} onSelect={selectTarget} calendar={calendar} />
        </SheetContent>
      </Sheet>

      <Sheet
        open={detailItem !== null && !inlineDetail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        <SheetContent side="right" showCloseButton={false} className="w-full p-0 sm:max-w-md">
          <SheetTitle className="sr-only">Reminder details</SheetTitle>
          {!inlineDetail && detailPane}
        </SheetContent>
      </Sheet>
    </div>
  );
}
