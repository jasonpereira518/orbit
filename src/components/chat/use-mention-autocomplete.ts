"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { searchEventsForPicker, type EventPickerOption } from "@/actions/chat";
import { searchContactsForPicker } from "@/actions/contacts";
import type { MentionOption } from "@/components/chat/mention-autocomplete";
import { interactionTypeLabel, interactionTypeNoun } from "@/lib/interaction-types";
import { mentionQueryAt, rankMentionCandidates } from "@/lib/chat-mentions";
import type { ContactPickerOption } from "@/lib/contacts-page";

/**
 * The state behind the composer's `@` type-ahead.
 *
 * Split from the panel because it owns four pieces of state that only make sense together
 * — where the token starts, what has been typed, what came back, and which row the
 * keyboard is on — and the panel is already carrying dictation, mentions and suggestions.
 */

/**
 * Zero: the menu opens on the bare `@`.
 *
 * It used to wait for a character, because a bare `@` has nothing to rank by and the picker
 * ordered alphabetically — so the sigil alone offered whoever came first in the address
 * book, which reads as broken rather than as waiting. The picker now answers "who have I
 * spoken to most recently" for an empty term, so there is something worth showing from the
 * moment the `@` lands.
 */
const MIN_QUERY_CHARS = 0;
/** Matches the `+` menu's, so the two feel like one surface. */
const SEARCH_DEBOUNCE_MS = 140;
const MAX_PEOPLE = 5;
const MAX_EVENTS = 3;

function eventDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export type MentionAutocompleteState = {
  open: boolean;
  options: MentionOption[];
  activeIndex: number;
  loading: boolean;
  /** Index of the `@`, so the caller can replace from there to the caret. */
  start: number | null;
  /** Re-read the box. Call on every change and every caret move. */
  refresh: (text: string, caret: number) => void;
  /** Close for this token only; typing a new `@` reopens. */
  dismiss: () => void;
  /** Forget everything, for when the box is cleared out from under us. */
  reset: () => void;
  move: (delta: number) => void;
  active: () => MentionOption | null;
};

export function useMentionAutocomplete(enabled: boolean): MentionAutocompleteState {
  const [start, setStart] = useState<number | null>(null);
  const [term, setTerm] = useState("");
  /** The `@` position the user dismissed, so Escape sticks until they start another. */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [people, setPeople] = useState<ContactPickerOption[]>([]);
  const [events, setEvents] = useState<EventPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  // Paired with the token it belongs to, so a new query resets the cursor during render
  // rather than in an effect that would cascade a second pass. Keyed on the `@` position
  // as well as the text: without the position, arrowing down on one `@Mar` and then typing
  // a different `@Mar` later in the sentence would silently reuse the old row.
  const [cursor, setCursor] = useState<{ token: string; index: number }>({ token: "", index: 0 });
  const runRef = useRef(0);

  const live =
    enabled && start !== null && start !== dismissedStart && term.trim().length >= MIN_QUERY_CHARS;
  const searchTerm = live ? term.trim() : "";

  useEffect(() => {
    // `live`, not `searchTerm`: an empty term is now a legitimate search — the bare `@`
    // asks for the most recent people. While the minimum was one character the two were
    // the same condition, and keying on the term is what kept the menu shut on `@` alone.
    if (!live) return;
    const run = ++runRef.current;
    // Inside the timer, not the effect body: a keystroke that gets debounced away should
    // never have flashed a loading state.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const [p, e] = await Promise.all([
          // "recent" is what makes the bare `@` worth opening. With a term the server
          // filters and `rankMentionCandidates` reorders on the client, so it does not
          // matter there.
          searchContactsForPicker(searchTerm, 12, "recent").catch(
            () => [] as ContactPickerOption[]
          ),
          searchEventsForPicker(searchTerm, 8).catch(() => [] as EventPickerOption[]),
        ]);
        // Only the newest search may write: a slow early query must not overwrite a fast
        // later one and offer rows for a prefix the user has already typed past.
        if (runRef.current === run) {
          setPeople(p);
          setEvents(e);
        }
      } finally {
        if (runRef.current === run) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live, searchTerm]);

  const options = useMemo<MentionOption[]>(() => {
    if (!live) return [];
    const rankedPeople = rankMentionCandidates(term, people, (p) => [
      p.preferredName,
      p.fullName,
      p.company,
    ]).slice(0, MAX_PEOPLE);
    const rankedEvents = rankMentionCandidates(term, events, (e) => [
      e.contactName,
      e.summary,
    ]).slice(0, MAX_EVENTS);

    return [
      ...rankedPeople.map<MentionOption>((p) => ({
        kind: "person",
        id: `person:${p.id}`,
        title: p.preferredName?.trim() || p.fullName,
        subtitle: p.company,
        contactId: p.id,
        firstName: p.firstName,
        fullName: p.fullName,
        avatarUrl: p.avatarUrl,
        nameCandidates: [
          p.preferredName?.trim() || "",
          p.fullName,
          p.company ? `${p.preferredName?.trim() || p.fullName} (${p.company})` : "",
        ].filter(Boolean),
      })),
      ...rankedEvents.map<MentionOption>((e) => {
        const label = interactionTypeLabel(e.interactionType);
        return {
          kind: "event",
          id: `event:${e.id}`,
          title: `${e.contactName} — ${label.toLowerCase()}`,
          subtitle: e.summary || eventDate(e.interactionDate),
          contactId: e.contactId,
          contactName: e.contactName,
          contactFirstName: e.contactFirstName,
          avatarUrl: e.contactAvatarUrl,
          interactionType: e.interactionType,
          // The noun, not the lowercased label: "my in person with Marcus" is not English.
          // Same map the `+` menu uses, so the two surfaces phrase an event identically.
          before: `my ${interactionTypeNoun(e.interactionType)} with `,
          after: ` on ${eventDate(e.interactionDate)}`,
          nameCandidates: [e.contactName],
        };
      }),
    ];
  }, [live, term, people, events]);

  const token = `${start ?? -1}:${term}`;
  const activeIndex =
    cursor.token === token ? Math.min(cursor.index, Math.max(0, options.length - 1)) : 0;

  return {
    // Kept open while a search is in flight so the panel does not blink out between
    // keystrokes and back in.
    open: live && (options.length > 0 || loading),
    options,
    activeIndex,
    loading,
    start,
    refresh(text, caret) {
      const found = mentionQueryAt(text, caret);
      setStart(found?.start ?? null);
      setTerm(found?.query ?? "");
      // A dismissal belongs to one `@`; moving to a different one clears it.
      if (found === null || found.start !== dismissedStart) setDismissedStart(null);
    },
    dismiss() {
      setDismissedStart(start);
    },
    reset() {
      setStart(null);
      setTerm("");
      setDismissedStart(null);
    },
    move(delta) {
      if (!options.length) return;
      const next = (activeIndex + delta + options.length) % options.length;
      setCursor({ token, index: next });
    },
    active() {
      return options[activeIndex] ?? null;
    },
  };
}
