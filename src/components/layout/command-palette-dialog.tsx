"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { format, parseISO } from "date-fns";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BellPlus,
  CornerDownLeft,
  Loader2,
  Moon,
  PenLine,
  Search,
  Sparkles,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { searchContactsForPicker } from "@/actions/contacts";
import { openCompose } from "@/lib/compose-events";
import { createReminder, deleteReminderAction } from "@/actions/reminders";
import { saveThemePreference } from "@/actions/settings";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { useFullPrefetch } from "@/lib/intent-prefetch";
import {
  ACTIONS,
  INTEGRATIONS,
  PAGES,
  SETTINGS,
  type Command,
} from "@/components/layout/command-palette-entries";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { requestAskBar } from "@/lib/ask-bar-events";
import { handOffToCapture } from "@/lib/capture-handoff";
import {
  emailVerbTerm,
  isComingSoonEntry,
  looksLikeNote,
  looksLikeQuestion,
  rankEntries,
  scoreEntry,
  visibleEntries,
} from "@/lib/command-palette";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen, useFeedbackAvailable } from "@/lib/feedback-events";
import { parseReminderPhrase } from "@/lib/reminder-phrase";
import { runToastAction } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";
import type { ContactPickerOption } from "@/lib/contacts-page";
import { cn } from "@/lib/utils";

/** How the palette can hand a question over, decided by the shell — see `CommandPalette`. */
export type PaletteAskMode = "bar" | "chat" | null;

type Row = {
  id: string;
  group: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Keep the hint on every row, not just the highlighted one — a person's company is who they are. */
  hintAlways?: boolean;
  icon: ReactNode;
  run: () => void;
  /** Shift+Enter, when a row has a second, more deliberate reading (see the reminder row). */
  alt?: () => void;
  /** A route worth fetching in full while this row is highlighted — a person's profile. */
  prefetchHref?: string;
};

const RECENT_CONTACTS = 5;
const SEARCH_CONTACTS = 8;
const SEARCH_DEBOUNCE_MS = 140;

/** A bare glyph in an avatar-sized slot, so icons and faces line up down the list. */
function CommandIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground transition-colors group-aria-selected:text-primary">
      <Icon className="size-4" strokeWidth={1.75} aria-hidden />
    </span>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border/60 bg-background px-1 font-sans text-2xs text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * The palette itself — search, the list, and keyboard handling. Loaded on first open by
 * `CommandPalette`, which is all the shell pays for up front.
 *
 * One list, not a list per group: arrow keys move through every row in the order shown,
 * across group headings, the way people expect from ⌘K in every other tool. It follows
 * the WAI-ARIA combobox pattern — focus stays in the input and `aria-activedescendant`
 * names the highlighted row — so a screen reader hears each row as it is reached.
 */
export function CommandPaletteDialog({
  open,
  onOpenChange,
  hidden,
  comingSoon,
  askMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden: ReadonlySet<string>;
  /** Pages marked coming soon: still listed, and tagged, as the sidebar tags them. */
  comingSoon: ReadonlySet<string>;
  askMode: PaletteAskMode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [, startThemeSave] = useTransition();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [people, setPeople] = useState<ContactPickerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState(query);

  // Back to the first row whenever the text changes — derived during render rather than
  // in an effect, so the highlight never paints one frame on a row that just moved.
  if (lastQuery !== query) {
    setLastQuery(query);
    setActiveIndex(0);
  }

  // Only while the widget is on the page: the verb opens its panel, and there is nothing to
  // open on a route (or in a shell) that does not mount it.
  const feedbackAvailable = useFeedbackAvailable();
  const contactsVisible = !hidden.has("page.contacts");
  // Same test as the Reminders page itself, so "New reminder: …" goes dark along with it.
  const remindersVisible = !hidden.has("page.reminders");
  // The same test the Capture actions pass, so "Capture this" goes dark along with them.
  const captureVisible = !hidden.has("page.capture");
  // "email maya": people rows open Compose instead of the profile. Null unless Compose is
  // available to this viewer and the query is the verb.
  const emailTerm = contactsVisible && !hidden.has(COMPOSE_SURFACE_KEY) ? emailVerbTerm(query) : null;

  // People: the most recently seen when nothing is typed, a search once something is.
  // Every response is tagged, and anything but the latest is dropped, so a slow reply for
  // "sa" can never overwrite the faster one for "sarah".
  useEffect(() => {
    if (!open || !contactsVisible) return;
    const term = (emailTerm ?? query).trim();
    const request = ++requestRef.current;
    const timer = window.setTimeout(
      async () => {
        setSearching(true);
        try {
          const rows = await searchContactsForPicker(
            term || undefined,
            term ? SEARCH_CONTACTS : RECENT_CONTACTS,
            "recent",
            "command_palette"
          );
          if (request === requestRef.current) setPeople(rows);
        } catch {
          if (request === requestRef.current) setPeople([]);
        } finally {
          if (request === requestRef.current) setSearching(false);
        }
      },
      term ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => window.clearTimeout(timer);
  }, [open, query, emailTerm, contactsVisible]);

  function close() {
    onOpenChange(false);
  }

  function go(href: string) {
    close();
    router.push(href);
  }

  const isDark = resolvedTheme === "dark";

  const rows = useMemo<Row[]>(() => {
    const term = query.trim();
    const out: Row[] = [];

    const commandRow = (group: string, c: Command): Row => {
      const soon = isComingSoonEntry(c, comingSoon);
      return {
        id: c.id,
        group,
        label: c.label,
        // A tag, not a refusal: the page still opens, on its teaser. Always shown, so it is
        // read before Enter rather than after.
        hint: soon ? "Coming soon" : c.hint,
        hintAlways: soon || undefined,
        icon: <CommandIcon icon={c.icon} />,
        run: () => {
          if (c.verb === "compose") {
            close();
            openCompose({ contactId: null });
          } else if (c.verb === "feedback") {
            close();
            requestFeedbackOpen(FEEDBACK_ANCHOR_FALLBACK);
          } else go(c.href!);
        },
      };
    };
    // What this viewer may see: the operator's hidden surfaces, and the feedback verb only
    // while the widget it opens is mounted.
    const available = (list: Command[]) =>
      visibleEntries(list, hidden).filter((c) => c.verb !== "feedback" || feedbackAvailable);

    const themeCommand: Command = {
      id: "action:theme",
      label: isDark ? "Switch to light mode" : "Switch to dark mode",
      icon: isDark ? Sun : Moon,
      keywords: "theme appearance dark light night",
    };

    const askRow: Row | null =
      askMode && term
        ? {
            id: "ask",
            group: "Ask",
            label: (
              <>
                Ask your network: <span className="font-medium text-ink">&ldquo;{term}&rdquo;</span>
              </>
            ),
            hint: askMode === "chat" ? "Opens Chat" : undefined,
            icon: <CommandIcon icon={Sparkles} />,
            run: () => {
              close();
              if (askMode === "bar") requestAskBar({ question: term });
              else router.push(`/chat?q=${encodeURIComponent(term)}`);
            },
          }
        : null;

    // Whatever was typed, as the start of a capture. Offered for any text, since only the
    // person knows whether "Sarah Stripe" is a search or a note, but it only leads when the
    // text reads like a sentence (`looksLikeNote`).
    const captureRow: Row | null =
      term && captureVisible
        ? {
            id: "capture-this",
            group: "Capture",
            label: (
              <>
                Capture this: <span className="font-medium text-ink">&ldquo;{term}&rdquo;</span>
              </>
            ),
            icon: <CommandIcon icon={PenLine} />,
            run: () => {
              close();
              handOffToCapture(term);
              // Already on the general capture page: the event alone delivers it, and
              // navigating would reload a page that is holding someone's draft.
              const onGeneralCapture =
                pathname === "/capture" &&
                !new URLSearchParams(window.location.search).get("contactId");
              if (!onGeneralCapture) router.push("/capture");
            },
          }
        : null;

    // "remind me to call Sam friday": the sentence says what it is, so Enter SETS the reminder
    // (title, and the day when it names one) and says so in a toast with an Undo. Shift+Enter is
    // the slower reading: the New reminder form, already filled in, for notes or a list first.
    const reminder = remindersVisible && term ? parseReminderPhrase(term) : null;
    const dueText = reminder?.due ? format(parseISO(reminder.due), "EEE, MMM d") : null;
    const reminderRow: Row | null = reminder
      ? {
          id: "reminder-this",
          group: "Reminder",
          label: (
            <>
              Set reminder: <span className="font-medium text-ink">&ldquo;{reminder.title}&rdquo;</span>
            </>
          ),
          hint: `${dueText ?? "No date"} · ⇧↵ to edit first`,
          hintAlways: true,
          icon: <CommandIcon icon={BellPlus} />,
          run: () => {
            close();
            void runToastAction({
              run: () => createReminder({ title: reminder.title, dueDate: reminder.due ?? undefined }),
              success: `${TOAST_COPY.reminderSet}: \u201c${reminder.title}\u201d${dueText ? ` \u00b7 ${dueText}` : ""}`,
              failure: "Couldn’t set that reminder — try again?",
              refresh: () => router.refresh(),
              // Undo is the reminder list's own delete (a soft dismiss), so it can be brought back.
              undo: (row) => (row?.id ? () => deleteReminderAction(row.id) : null),
              undone: "Reminder removed",
            });
          },
          alt: () =>
            go(
              `/reminders?new=1&title=${encodeURIComponent(reminder.title)}${reminder.due ? `&due=${reminder.due}` : ""}`
            ),
        }
      : null;

    // A question goes to the front: typing "who do I know at Stripe?" and pressing Enter
    // should ask it, not open whichever page happened to contain the word "know".
    const question = askRow && looksLikeQuestion(term);
    if (question) out.push(askRow);
    if (reminderRow) out.push(reminderRow);
    // A note goes to the front for the same reason: nothing else will match a sentence,
    // and Enter should do the one thing it can mean. Not when it is a reminder: that sentence is
    // also long enough to read as a note, and the reminder is the better reading of it.
    const note = captureRow && !reminderRow && looksLikeNote(term);
    if (note) out.push(captureRow);

    if (emailTerm) {
      // The verb asks for one thing, so its rows are the whole answer.
      return people.map((p) => ({
        id: `email:${p.id}`,
        group: "Email",
        label: `Email ${p.preferredName || p.fullName}`,
        hint: p.company ?? undefined,
        hintAlways: true,
        icon: (
          <ContactAvatar
            contactId={p.id}
            firstName={p.firstName}
            fullName={p.fullName}
            profileImageUrl={p.avatarUrl}
            size="sm"
            className="size-7"
          />
        ),
        run: () => {
          close();
          openCompose({ contactId: p.id });
        },
      }));
    }

    const personRows: Row[] =
      contactsVisible
        ? people.map((p) => ({
            id: `contact:${p.id}`,
            group: term ? "People" : "Recent",
            label: p.preferredName || p.fullName,
            hint: p.company ?? undefined,
            hintAlways: true,
            icon: (
              <ContactAvatar
                contactId={p.id}
                firstName={p.firstName}
                fullName={p.fullName}
                profileImageUrl={p.avatarUrl}
                size="sm"
                className="size-7"
              />
            ),
            run: () => go(`/contacts/${p.id}`),
            prefetchHref: `/contacts/${p.id}`,
          }))
        : [];
    // Empty, the palette is mostly a way back to someone, so they lead.
    if (!term) out.push(...personRows);

    // "Share my card" is off until the card is released, like the header icon.
    const visibleActions = available(ACTIONS).filter(
      (c) => c.id !== "action:share-card" || !comingSoon.has("page.card")
    );
    const actions = term ? rankEntries(visibleActions, term) : visibleActions.filter((c) => c.featured);
    const theme = term ? rankEntries([themeCommand], term) : [];
    const actionRows: Row[] = [
      ...actions.map((c) => commandRow("Actions", c)),
      ...theme.map((c) => ({
        ...commandRow("Actions", c),
        run: () => {
          const next = isDark ? "light" : "dark";
          setTheme(next);
          startThemeSave(async () => {
            await saveThemePreference(next).catch(() => {});
          });
          close();
        },
      })),
    ];

    let pageEntries = available(PAGES).filter((c) => c.href !== pathname);
    // Empty, pages keep the sidebar's order, which puts the coming-soon ones last.
    if (!term) {
      pageEntries = [
        ...pageEntries.filter((c) => !isComingSoonEntry(c, comingSoon)),
        ...pageEntries.filter((c) => isComingSoonEntry(c, comingSoon)),
      ];
    }
    const pages = rankEntries(pageEntries, term);
    const pageRows = pages.map((c) => commandRow("Go to", c));
    const settingRows = term
      ? rankEntries([...available(SETTINGS), ...available(INTEGRATIONS)], term).map((c) => commandRow("Settings", c))
      : // Only once something is typed: sixteen of them would bury the useful rows on an
        // empty palette, and nobody browses to "Webhooks".
        [];

    if (!term) {
      // People already lead (above); then the featured actions, then the pages.
      out.push(...actionRows, ...pageRows);
    } else {
      // Groups lead by how well their best row matches, not by a fixed order: "google" is the
      // Integrations page, not the eight people who work there, and "contacts" is the page,
      // not the first of a dozen "Contacts quiet for…" actions. Ties keep the old order
      // (pages, actions, people, settings), so an action that merely starts with the same word
      // never outranks the place that has the name. People are ranked by the server, so they
      // are scored by their name and company when that matches, and as a weak hit otherwise.
      const best = (list: Command[]) => Math.max(0, ...list.map((c) => scoreEntry(term, c)));
      const personScore = personRows.length
        ? Math.max(
            3,
            ...people.map((p) => scoreEntry(term, { label: p.preferredName || p.fullName, keywords: p.company ?? "" }))
          )
        : 0;
      const groups = [
        { rows: pageRows, score: best(pages), rank: 0 },
        { rows: actionRows, score: best([...actions, ...theme]), rank: 1 },
        { rows: personRows, score: personScore, rank: 2 },
        { rows: settingRows, score: best(rankEntries([...available(SETTINGS), ...available(INTEGRATIONS)], term)), rank: 3 },
      ].sort((x, y) => y.score - x.score || x.rank - y.rank);
      for (const g of groups) out.push(...g.rows);
    }

    if (captureRow && !note) out.push(captureRow);
    if (askRow && !question) out.push(askRow);
    return out;
    // `go`/`close` only close over stable setters and the router.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, people, hidden, comingSoon, askMode, pathname, isDark, contactsVisible, captureVisible, remindersVisible, emailTerm, feedbackAvailable]);

  const active = rows[Math.min(activeIndex, Math.max(rows.length - 1, 0))];

  // Fetch the highlighted person's whole profile while they stay highlighted, so Enter lands
  // with no skeleton. Debounced: arrowing through the list should not render every profile.
  const prefetchFull = useFullPrefetch();
  const activePrefetch = active?.prefetchHref;
  useEffect(() => {
    if (!open || !activePrefetch) return;
    const t = window.setTimeout(() => prefetchFull(activePrefetch), 100);
    return () => window.clearTimeout(t);
  }, [open, activePrefetch, prefetchFull]);

  // Keep the highlighted row on screen as the arrow keys walk past the fold.
  useEffect(() => {
    if (!active) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(active.id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!rows.length) return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(rows.length - 1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.shiftKey && active?.alt) active.alt();
      else active?.run();
    }
  }

  let lastGroup: string | null = null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        // Reset on the way out rather than in, so reopening lands on a clean slate without
        // flashing the previous search while the dialog fades back in.
        if (!next) {
          setQuery("");
          setActiveIndex(0);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        className="top-[14dvh] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-foreground/[0.08] sm:max-w-[34rem]"
      >
        <DialogTitle className="sr-only">Search Orbit</DialogTitle>
        <div className="flex items-center gap-3 px-4">
          <Search className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          <input
            ref={inputRef}
            aria-label="Search Orbit"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              askMode ? "Find someone, go somewhere, or ask a question" : "Find someone or go somewhere"
            }
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={active ? `${listboxId}-${active.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground-subtle"
          />
          {searching && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground-subtle" aria-hidden />}
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Results"
          className="max-h-[min(60dvh,26rem)] overflow-y-auto overscroll-contain border-t border-border/50 px-2 pb-2"
        >
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center">
              {searching ? (
                <p className="text-sm text-muted-foreground">Looking…</p>
              ) : (
                <>
                  <p className="text-sm text-foreground">
                    Nothing for <span className="font-medium text-ink">&ldquo;{query.trim()}&rdquo;</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Try a name, a company or a page.</p>
                </>
              )}
            </div>
          ) : (
            rows.map((row) => {
              const heading = row.group !== lastGroup ? row.group : null;
              lastGroup = row.group;
              const selected = row.id === active?.id;
              return (
                <div key={row.id} role="presentation">
                  {heading && (
                    <p role="presentation" className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
                      {heading}
                    </p>
                  )}
                  <div
                    id={`${listboxId}-${row.id}`}
                    data-row-id={row.id}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => {
                      const index = rows.indexOf(row);
                      if (index !== activeIndex) setActiveIndex(index);
                    }}
                    // mousedown, not click: the input must keep focus, or the next arrow key
                    // goes nowhere.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={row.run}
                    className={cn(
                      "group flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-sm transition-colors duration-100",
                      selected ? "bg-primary/[0.07] text-ink dark:bg-primary/[0.12]" : "text-foreground/85"
                    )}
                  >
                    {row.icon}
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.hint && (row.hintAlways || selected) && (
                      <span className="hidden max-w-[45%] shrink truncate text-xs text-muted-foreground sm:inline">
                        {row.hint}
                      </span>
                    )}
                    {selected && (
                      <CornerDownLeft
                        className="hidden size-3.5 shrink-0 text-muted-foreground-subtle [@media(hover:hover)]:block"
                        aria-hidden
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="hidden items-center gap-4 border-t border-border/50 bg-muted/30 px-4 py-2 text-xs text-muted-foreground [@media(hover:hover)]:flex">
          <span className="flex items-center gap-1.5">
            <Key>↑</Key>
            <Key>↓</Key>
            move
          </span>
          <span className="flex items-center gap-1.5">
            <Key>
              <CornerDownLeft className="size-3" aria-hidden />
            </Key>
            open
          </span>
          <span className="flex items-center gap-1.5">
            <Key>esc</Key>
            close
          </span>
          {askMode === "bar" && (
            <span className="ml-auto flex items-center gap-1.5">
              <Key>⌘J</Key>
              ask your network
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
