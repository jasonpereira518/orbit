"use client";

/**
 * The composer's `+` — pull a person or a past meeting into the question you are asking.
 *
 * Chat retrieval is text-driven, so "grounding" a question is literally a matter of getting
 * the right name or meeting into the prompt. This inserts that text at the caret rather
 * than maintaining a parallel structure of attachments the model would never see.
 *
 * People are the exception, and only just: picking one still inserts plain text — an
 * `@Name` token — but it hands the caller the contact id alongside, so the send path can
 * put that person's role and timeline in front of the model. The token remains the source
 * of truth; delete it from the box and the attachment goes with it.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, Plus, Search, User } from "lucide-react";

import { searchEventsForPicker, type EventPickerOption } from "@/actions/chat";
import { searchContactsForPicker } from "@/actions/contacts";
import type { ContactPickerOption } from "@/lib/contacts-page";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { EventAvatar } from "@/components/chat/event-avatar";
import { Button } from "@/components/ui/button";
import { interactionTypeLabel, interactionTypeNoun } from "@/lib/interaction-types";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Tab = "people" | "events";

/**
 * What picking a row asks the composer to do.
 *
 * A person is not just text: the caller has to mint a token that does not collide with an
 * already-attached namesake, so the menu passes the candidate names rather than choosing.
 */
export type ComposerInsert =
  | { kind: "text"; text: string }
  /**
   * A past meeting, whose phrase is built around the person's own `@Name` token.
   *
   * The obvious shape was plain prose — "my coffee with Marcus on Aug 15" — but then the
   * person it happened with is attached to nothing, and the model has to find Marcus by
   * name through retrieval, which hands over far less than the attached block does.
   * Splicing the token into the sentence reuses the whole mention mechanism instead: it
   * goes green, deletes as one object, and drops out of the question if you remove it.
   * The caller mints the token, because only it knows which names are already taken.
   */
  | {
      kind: "event";
      contactId: string;
      nameCandidates: string[];
      /** Sentence either side of the token: "my coffee with " + token + " on Aug 15". */
      before: string;
      after: string;
    }
  | {
      kind: "person";
      contactId: string;
      /** Preferred name first, then full name — the caller takes the first that is free. */
      nameCandidates: string[];
    };

/** Matches the composer's own debounce so typing does not fire a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 180;

function formatEventDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function ComposerToolsMenu({
  disabled,
  onInsert,
}: {
  disabled: boolean;
  /** What to splice in at the caret. The caller owns the composer. */
  onInsert: (item: ComposerInsert) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("people");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<ContactPickerOption[]>([]);
  const [events, setEvents] = useState<EventPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const searchId = useId();
  // Only the newest search may write results; a slow early query must not overwrite a
  // fast later one.
  const runRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const run = ++runRef.current;
    // Inside the timer, not the effect body: a keystroke that gets debounced away should
    // never have flashed a loading state in the first place.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        if (tab === "people") {
          const rows = await searchContactsForPicker(query, 20, "recent");
          if (runRef.current === run) setPeople(rows);
        } else {
          const rows = await searchEventsForPicker(query, 20);
          if (runRef.current === run) setEvents(rows);
        }
      } catch {
        // A failed lookup leaves the last results up rather than blanking the menu.
      } finally {
        if (runRef.current === run) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, tab, query]);

  const rows = useMemo(
    () =>
      tab === "people"
        ? people.map((p) => ({
            key: p.id,
            title: p.preferredName?.trim() || p.fullName,
            subtitle: p.company || null,
            // A face is how you recognise the right Chris out of three. The url is already
            // browser-safe from `clientAvatarUrlSql`; `ContactAvatar` routes it through
            // `/api/avatars/{id}` and falls back to the gendered illustration.
            avatar: (
              <ContactAvatar
                contactId={p.id}
                firstName={p.firstName}
                fullName={p.fullName}
                profileImageUrl={p.avatarUrl}
                size="sm"
                className="size-7"
              />
            ),
            insert: {
              kind: "person" as const,
              contactId: p.id,
              nameCandidates: [
                p.preferredName?.trim() || "",
                p.fullName,
                p.company ? `${p.preferredName?.trim() || p.fullName} (${p.company})` : "",
              ].filter(Boolean),
            },
          }))
        : events.map((e) => {
            // Reuse the app's own vocabulary rather than de-underscoring the raw column:
            // "in_person" reads as "In person" in a list and "catch-up" in a sentence.
            const label = interactionTypeLabel(e.interactionType);
            return {
              key: e.id,
              title: `${e.contactName} — ${label.toLowerCase()}`,
              subtitle: e.summary || formatEventDate(e.interactionDate),
              // Whose meeting it was, badged with what kind. The tab keeps its own
              // calendar icon; the rows carry the face you actually recognise.
              avatar: (
                <EventAvatar
                  contactId={e.contactId}
                  contactName={e.contactName}
                  contactFirstName={e.contactFirstName}
                  avatarUrl={e.contactAvatarUrl}
                  interactionType={e.interactionType}
                />
              ) as React.ReactNode,
              insert: {
                kind: "event" as const,
                contactId: e.contactId,
                nameCandidates: [e.contactName],
                before: `my ${interactionTypeNoun(e.interactionType)} with `,
                after: ` on ${formatEventDate(e.interactionDate)}`,
              },
            };
          }),
    [tab, people, events]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="composer-tools"
            disabled={disabled}
            aria-label="Add a person or event to your question"
            title="Add a person or event"
            className="size-9 shrink-0 rounded-full text-muted-foreground"
          >
            <Plus className="size-4" />
          </Button>
        }
      />
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <div className="flex items-center gap-1 border-b border-border/60 p-1.5">
          {(["people", "events"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-colors",
                tab === t
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              )}
              aria-pressed={tab === t}
            >
              {t === "people" ? (
                <User className="size-3.5" />
              ) : (
                <CalendarDays className="size-3.5" />
              )}
              {t}
            </button>
          ))}
        </div>

        <div className="relative border-b border-border/60">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "people" ? "Search people…" : "Search meetings…"}
            className="h-9 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0"
            autoFocus
          />
        </div>

        {/* What the green token will mean once it is in the box. Worth a line: the menu
            otherwise looks like it only types a name for you. */}
        {tab === "people" && (
          <p className="border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
            Adds their role and interaction history to your question.
          </p>
        )}

        <div className="max-h-64 overflow-y-auto p-1">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {loading
                ? "Searching…"
                : tab === "people"
                  ? "No one matches that."
                  : "No meetings match that."}
            </p>
          ) : (
            rows.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => {
                  onInsert(row.insert);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                {row.avatar}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{row.title}</span>
                  {row.subtitle && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.subtitle}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
