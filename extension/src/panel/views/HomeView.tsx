/**
 * Home — the panel beside a page that isn't about anyone it can act on.
 *
 * It replaces three dead ends: the unclicked-tab hint, "Orbit can't read this
 * page", and "Nothing to add here". Each said what the panel couldn't do and
 * stopped. Home says the same thing in one line and then is useful anyway,
 * because the panel's job is the user's network, not only the open tab:
 *
 *   hint     why this tab isn't being read, when that's the case
 *   due      what you owe people today — the reminders page's own rule
 *   find     anyone: search, or the people you touched lately
 *   note     pick someone, jot what happened, done — from any page
 *
 * Same reading order as the known-contact view: what you owe before what you
 * know. Bands, not cards, per the rules in components/ui.tsx.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MousePointerClick, Search } from "lucide-react";
import type {
  ContactSearchResponse,
  ContactSearchResult,
  HomeResponse,
  MeResponse,
} from "@contract";
import type { OrbitApi } from "@/lib/api";
import { browser } from "@/lib/browser";
import { cn } from "@/lib/cn";
import { APP_URL } from "@/lib/env";
import { shortAgo } from "@/lib/format";
import { unlockFeature } from "@/lib/unlock";
import { Avatar, Button, Meta, MicroLabel, Section } from "../components/ui";
import type { HomeReason } from "../state/route";

const viewerTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function PersonRow({
  person,
  selected,
  onSelect,
}: {
  person: ContactSearchResult;
  selected: boolean;
  onSelect: (person: ContactSearchResult) => void;
}) {
  return (
    <button
      onClick={() => onSelect(person)}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-[var(--accent)]",
        selected && "bg-[var(--accent)]"
      )}
    >
      <Avatar src={person.photoUrl} name={person.fullName} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-[18px]">{person.fullName}</span>
        <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
          {[person.title, person.company].filter(Boolean).join(" · ") || "\u00a0"}
        </span>
      </span>
    </button>
  );
}

function Hint({
  reason,
  detail,
  lostAccess,
  onOpenSettings,
}: {
  reason: HomeReason;
  detail: string | null;
  lostAccess: boolean;
  onOpenSettings: () => void;
}) {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    if (reason === "no-grant") void browser().actionShortcut().then(setShortcut);
  }, [reason]);

  if (reason === "no-person") return null;

  if (reason === "unreadable") {
    return (
      <Section hairline={false}>
        <p className="text-[13px] font-medium leading-snug">
          {lostAccess ? "This page reloaded" : "Orbit can't read this page"}
        </p>
        <Meta className="mt-1 max-w-[38ch]">
          {lostAccess
            ? "Click the Orbit icon to read it again."
            : (detail ?? "Chrome doesn't let extensions read it.")}
        </Meta>
      </Section>
    );
  }

  return (
    <Section hairline={false}>
      <div className="flex items-start gap-2">
        <MousePointerClick size={15} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
        <div>
          <p className="text-[13px] font-medium leading-snug">
            Click the Orbit icon to read this tab
          </p>
          <Meta className="mt-1 max-w-[38ch]">
            Orbit reads a page only when you ask.{" "}
            {shortcut ? (
              <>
                Or press{" "}
                <kbd className="rounded border border-[var(--border)] px-1 font-sans text-[10px]">
                  {shortcut}
                </kbd>
                .{" "}
              </>
            ) : null}
            <button onClick={onOpenSettings} className="text-[var(--primary)] hover:underline">
              Choose sites Orbit follows
            </button>
          </Meta>
        </div>
      </div>
    </Section>
  );
}

export function HomeView({
  reason,
  detail,
  lostAccess,
  me,
  signedIn,
  api,
  onOpenSettings,
  onSignIn,
  onDirtyChange,
}: {
  reason: HomeReason;
  detail: string | null;
  lostAccess: boolean;
  me: MeResponse | null;
  /** null while the session is still loading. */
  signedIn: boolean | null;
  api: OrbitApi;
  onOpenSettings: () => void;
  onSignIn: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [homeFailed, setHomeFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ContactSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ContactSearchResult | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ message: string; undo?: () => void } | null>(null);
  const searchAbort = useRef<AbortController | null>(null);

  const toast = (message: string, undo?: () => void) => {
    setFlash({ message, undo });
    window.setTimeout(() => setFlash(null), undo ? 5000 : 1800);
  };

  const loadHome = useCallback(async () => {
    try {
      setHome(await api.home(viewerTimeZone()));
      setHomeFailed(false);
    } catch {
      setHomeFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (signedIn) void loadHome();
  }, [signedIn, loadHome]);

  // Debounced, and each keystroke cancels the last request.
  useEffect(() => {
    const q = query.trim();
    searchAbort.current?.abort();
    if (q.length < 2) {
      setSearch(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .searchContacts(q, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setSearch(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearch({ results: [], mode: "keyword" });
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, api]);

  // An unsaved note about someone holds the panel where it is, exactly as it
  // does on a contact: navigating must not silently drop it.
  const dirty = note.trim().length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const saveNote = async () => {
    if (!selected || !note.trim()) return;
    setBusy(true);
    try {
      await api.logInteraction({ contactId: selected.id, rawNotes: note.trim() });
      toast(`Note added for ${firstName(selected.fullName)}`);
      setNote("");
      setSelected(null);
      void loadHome();
    } catch {
      toast("Couldn't save that");
    } finally {
      setBusy(false);
    }
  };

  const complete = async (reminderId: string) => {
    setBusy(true);
    try {
      const { completion } = await api.reminder({ action: "complete", reminderId });
      toast("Marked done", () => {
        setFlash(null);
        if (!completion) return;
        void api
          .reminder({ action: "reopen", completion })
          .then(loadHome)
          .catch(() => toast("Couldn't undo that"));
      });
      void loadHome();
    } catch {
      toast("Couldn't mark that done");
    } finally {
      setBusy(false);
    }
  };

  const hint = (
    <Hint reason={reason} detail={detail} lostAccess={lostAccess} onOpenSettings={onOpenSettings} />
  );

  if (signedIn === false) {
    return (
      <div className="scroll-area flex-1">
        {hint}
        <Section title="Your orbit" hairline={reason !== "no-person"}>
          <Meta className="mb-2 max-w-[38ch]">
            Sign in to see what&apos;s due and find anyone in your orbit from here.
          </Meta>
          <Button size="sm" onClick={onSignIn}>
            Sign in to Orbit
          </Button>
        </Section>
      </div>
    );
  }

  const q = query.trim();
  const people = q.length >= 2 ? (search?.results ?? []) : (home?.recentContacts ?? []);
  const searchLocked = me?.entitlements?.features.search === false;
  const due = home?.dueReminders ?? [];

  return (
    <>
      <div className="scroll-area flex-1">
        {hint}

        <Section title="Due" hairline={reason !== "no-person"}>
          {homeFailed ? (
            <Meta>
              Couldn&apos;t load reminders.{" "}
              <button onClick={() => void loadHome()} className="text-[var(--primary)] hover:underline">
                Try again
              </button>
            </Meta>
          ) : home === null ? (
            <Meta>Loading…</Meta>
          ) : due.length === 0 ? (
            <Meta>Nothing due today.</Meta>
          ) : (
            <>
              {due.map((reminder) => (
                <div key={reminder.id} className="group flex items-baseline gap-2 py-0.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-[18px]">{reminder.title}</span>
                    {reminder.contact ? (
                      <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                        {reminder.contact.fullName}
                      </span>
                    ) : null}
                  </span>
                  <Meta
                    className={cn(
                      "shrink-0 whitespace-nowrap",
                      reminder.overdue && "!text-[var(--destructive)]"
                    )}
                  >
                    {reminder.overdue ? `${shortAgo(reminder.dueDate) ?? ""} late` : "today"}
                  </Meta>
                  <button
                    onClick={() => void complete(reminder.id)}
                    disabled={busy}
                    title="Mark done"
                    aria-label={`Mark "${reminder.title}" done`}
                    className="shrink-0 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--primary)] disabled:opacity-50 group-hover:opacity-100"
                  >
                    <Check size={12} />
                  </button>
                </div>
              ))}
              {home.dueReminderTotal > due.length ? (
                <button
                  onClick={() => browser().openTab(`${APP_URL}/reminders`)}
                  className="mt-1 text-[11px] text-[var(--primary)] hover:underline"
                >
                  All {home.dueReminderTotal} on Reminders
                </button>
              ) : null}
            </>
          )}
        </Section>

        <Section>
          <label className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 focus-within:border-[var(--ring)]">
            <Search size={13} className="shrink-0 text-[var(--muted-foreground)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find anyone in your orbit"
              aria-label="Find anyone in your orbit"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </label>

          <div className="mt-2">
            <MicroLabel className="mb-1">{q.length >= 2 ? "Matches" : "Recent"}</MicroLabel>
            {q.length >= 2 && !searching && search && people.length === 0 ? (
              <Meta>
                No one matches &ldquo;{q}&rdquo;.{" "}
                <button
                  onClick={() => browser().openTab(`${APP_URL}/contacts/new`)}
                  className="text-[var(--primary)] hover:underline"
                >
                  Add someone
                </button>
              </Meta>
            ) : null}
            <div className="space-y-0.5">
              {people.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  selected={selected?.id === person.id}
                  onSelect={(p) => setSelected(selected?.id === p.id ? null : p)}
                />
              ))}
            </div>
            {q.length >= 2 && searchLocked ? (
              <Meta className="mt-2">
                Pro also finds people by what you know about them.{" "}
                <button
                  onClick={() => void unlockFeature(api, "search")}
                  className="text-[var(--primary)] hover:underline"
                >
                  See plans
                </button>
              </Meta>
            ) : null}
          </div>
        </Section>
      </div>

      {selected ? (
        <div className="shrink-0 border-t border-[var(--border)] px-3 py-2.5">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <MicroLabel>Note about {firstName(selected.fullName)}</MicroLabel>
            <button
              onClick={() => browser().openTab(`${APP_URL}/contacts/${selected.id}`)}
              className="shrink-0 text-[11px] text-[var(--primary)] hover:underline"
            >
              Open in Orbit
            </button>
          </div>
          <textarea
            autoFocus
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveNote();
              if (e.key === "Escape") {
                setSelected(null);
                setNote("");
              }
            }}
            placeholder="What happened?"
            className="w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2 text-[13px] leading-[18px] outline-none focus:border-[var(--ring)]"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setNote("");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !note.trim()} onClick={() => void saveNote()}>
              Save note
            </Button>
          </div>
        </div>
      ) : null}

      {flash ? (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-[var(--border)] py-3 text-[12px] text-[var(--primary)]">
          <Check size={13} />
          {flash.message}
          {flash.undo ? (
            <button
              onClick={flash.undo}
              className="ml-2 text-[var(--muted-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
