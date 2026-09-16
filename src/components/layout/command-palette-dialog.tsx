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
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ArrowRight,
  CornerDownLeft,
  Loader2,
  Mic,
  Moon,
  PenLine,
  NotebookPen,
  Search,
  Settings,
  Sparkles,
  Sun,
  Upload,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { searchContactsForPicker } from "@/actions/contacts";
import { saveThemePreference } from "@/actions/settings";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { APP_NAV } from "@/components/layout/app-nav";
import { SETTINGS_SECTIONS } from "@/components/settings/sections";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { requestAskBar } from "@/lib/ask-bar-events";
import { handOffToCapture } from "@/lib/capture-handoff";
import {
  looksLikeNote,
  looksLikeQuestion,
  rankEntries,
  visibleEntries,
  type PaletteEntry,
} from "@/lib/command-palette";
import type { ContactPickerOption } from "@/lib/contacts-page";
import { cn } from "@/lib/utils";

/** How the palette can hand a question over, decided by the shell — see `CommandPalette`. */
export type PaletteAskMode = "bar" | "chat" | null;

type Command = PaletteEntry & {
  icon: LucideIcon;
  hint?: string;
};

type Row = {
  id: string;
  group: string;
  label: ReactNode;
  hint?: ReactNode;
  icon: ReactNode;
  run: () => void;
};

const RECENT_CONTACTS = 5;
const SEARCH_CONTACTS = 8;
const SEARCH_DEBOUNCE_MS = 140;

const ACTIONS: Command[] = [
  {
    id: "action:capture",
    label: "New capture",
    hint: "Paste notes or upload photos",
    href: "/capture",
    icon: Sparkles,
    keywords: "log interaction notes paste photo picture upload meeting extract add",
  },
  {
    id: "action:voice",
    label: "Record a voice note",
    href: "/capture?mode=voice",
    icon: Mic,
    keywords: "dictate audio speak capture microphone",
  },
  {
    id: "action:structured",
    label: "Log an interaction",
    hint: "Fill in the fields yourself",
    href: "/capture?mode=structured",
    icon: NotebookPen,
    keywords: "meeting call coffee note structured manual",
  },
  {
    id: "action:add-contact",
    label: "Add a contact",
    href: "/contacts/new",
    icon: UserPlus,
    keywords: "new person create",
  },
  {
    id: "action:import",
    label: "Import contacts",
    hint: "LinkedIn, contacts file, Google, Outlook",
    href: "/imports",
    icon: Upload,
    keywords: "linkedin csv vcard vcf google outlook iphone phone address book calendar ics",
  },
  {
    id: "action:duplicates",
    label: "Review duplicate contacts",
    href: "/contacts/duplicates",
    icon: Users,
    keywords: "merge dedupe same person",
  },
];

const PAGES: Command[] = [
  ...APP_NAV.map((item) => ({
    id: `page:${item.href}`,
    label: item.label,
    href: item.href,
    icon: item.icon,
    keywords: "go open page",
  })),
  {
    id: "page:/recruiters",
    label: "Recruiters",
    href: "/recruiters",
    icon: Users,
    keywords: "go open page recruiting hiring",
  },
];

const SETTINGS: Command[] = SETTINGS_SECTIONS.map((section) => ({
  id: `settings:${section.id}`,
  label: `Settings › ${section.label}`,
  href: `/settings#${section.id}`,
  settingsId: section.id,
  icon: Settings,
  keywords: "preferences configure",
}));

function CommandIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
    </span>
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
  askMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden: ReadonlySet<string>;
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

  const contactsVisible = !hidden.has("page.contacts");
  // The same test the Capture actions pass, so "Capture this" goes dark along with them.
  const captureVisible = !hidden.has("page.capture");

  // People: the most recently seen when nothing is typed, a search once something is.
  // Every response is tagged, and anything but the latest is dropped, so a slow reply for
  // "sa" can never overwrite the faster one for "sarah".
  useEffect(() => {
    if (!open || !contactsVisible) return;
    const term = query.trim();
    const request = ++requestRef.current;
    const timer = window.setTimeout(
      async () => {
        setSearching(true);
        try {
          const rows = await searchContactsForPicker(
            term || undefined,
            term ? SEARCH_CONTACTS : RECENT_CONTACTS,
            "recent"
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
  }, [open, query, contactsVisible]);

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

    const commandRow = (group: string, c: Command): Row => ({
      id: c.id,
      group,
      label: c.label,
      hint: c.hint,
      icon: <CommandIcon icon={c.icon} />,
      run: () => go(c.href!),
    });

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

    // A question goes to the front: typing "who do I know at Stripe?" and pressing Enter
    // should ask it, not open whichever page happened to contain the word "know".
    const question = askRow && looksLikeQuestion(term);
    if (question) out.push(askRow);
    // A note goes to the front for the same reason: nothing else will match a sentence,
    // and Enter should do the one thing it can mean.
    const note = captureRow && looksLikeNote(term);
    if (note) out.push(captureRow);

    const actions = rankEntries(visibleEntries(ACTIONS, hidden), term);
    const theme = rankEntries([themeCommand], term);
    out.push(...actions.map((c) => commandRow("Actions", c)));
    out.push(
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
      }))
    );

    if (contactsVisible && people.length) {
      out.push(
        ...people.map((p) => ({
          id: `contact:${p.id}`,
          group: term ? "People" : "Recent people",
          label: p.preferredName || p.fullName,
          hint: p.company ?? undefined,
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
        }))
      );
    }

    const pages = rankEntries(
      visibleEntries(PAGES, hidden).filter((c) => c.href !== pathname),
      term
    );
    out.push(...pages.map((c) => commandRow("Go to", c)));

    // Settings sections only once something is typed — thirteen of them would bury the
    // useful rows on an empty palette, and nobody browses to "Webhooks".
    if (term) {
      out.push(...rankEntries(visibleEntries(SETTINGS, hidden), term).map((c) => commandRow("Settings", c)));
    }

    if (captureRow && !note) out.push(captureRow);
    if (askRow && !question) out.push(askRow);
    return out;
    // `go`/`close` only close over stable setters and the router.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, people, hidden, askMode, pathname, isDark, contactsVisible, captureVisible]);

  const active = rows[Math.min(activeIndex, Math.max(rows.length - 1, 0))];

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
      active?.run();
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
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search Orbit</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border/70 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              askMode
                ? "Search people and pages, or ask a question…"
                : "Search people, pages and actions…"
            }
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={active ? `${listboxId}-${active.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {searching && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
          <kbd className="hidden shrink-0 rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground [@media(hover:hover)]:inline">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Results"
          className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-1.5"
        >
          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {searching ? "Searching…" : "Nothing matches that."}
            </p>
          ) : (
            rows.map((row) => {
              const heading = row.group !== lastGroup ? row.group : null;
              lastGroup = row.group;
              const selected = row.id === active?.id;
              return (
                <div key={row.id} role="presentation">
                  {heading && (
                    <p
                      role="presentation"
                      className="px-2 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                    >
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
                      "flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm",
                      selected ? "bg-muted text-foreground" : "text-foreground/90"
                    )}
                  >
                    {row.icon}
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.hint && (
                      <span className="hidden max-w-[45%] shrink truncate text-xs text-muted-foreground sm:inline">
                        {row.hint}
                      </span>
                    )}
                    {selected && (
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="hidden items-center gap-4 border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground [@media(hover:hover)]:flex">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/70 bg-muted/50 px-1">↑</kbd>
            <kbd className="rounded border border-border/70 bg-muted/50 px-1">↓</kbd>
            to move
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/70 bg-muted/50 px-1">
              <CornerDownLeft className="inline size-3" aria-hidden />
            </kbd>
            to open
          </span>
          {askMode === "bar" && (
            <span className="ml-auto flex items-center gap-1">
              <kbd className="rounded border border-border/70 bg-muted/50 px-1">⌘J</kbd>
              ask your network
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
