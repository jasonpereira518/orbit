"use client";

import { useMemo, useState } from "react";

import type { CommandOption } from "@/components/composer/mention-autocomplete";
import { commandsFor, slashQueryAt } from "@/lib/chat-commands";

/**
 * The state behind the composer's `/` command menu — the synchronous sibling of
 * `useMentionAutocomplete`, with the same shape so the composer can drive whichever is open
 * with one set of keys. Nothing here is async: the list is a handful of constants ranked in
 * memory, so there is no loading state and no debounce.
 */
export type SlashCommandState = {
  open: boolean;
  options: CommandOption[];
  activeIndex: number;
  /** Index of the `/`, so the caller can replace from there to the caret. */
  start: number | null;
  refresh: (text: string, caret: number) => void;
  /** Close for this token only; typing a new `/` reopens. */
  dismiss: () => void;
  reset: () => void;
  move: (delta: number) => void;
  active: () => CommandOption | null;
};

export function useSlashCommands(
  enabled: boolean,
  hidden: ReadonlySet<string>,
): SlashCommandState {
  const [start, setStart] = useState<number | null>(null);
  const [term, setTerm] = useState("");
  /** The `/` the user dismissed, so Escape sticks until they start another. */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  // Keyed on the token, as the `@` menu's cursor is, so a new query resets it during render.
  const [cursor, setCursor] = useState<{ token: string; index: number }>({ token: "", index: 0 });

  const live = enabled && start !== null && start !== dismissedStart;

  const options = useMemo<CommandOption[]>(() => {
    if (!live) return [];
    return commandsFor(term, hidden).map((command) => ({
      kind: "command",
      id: command.id,
      title: `/${command.slug}`,
      subtitle: command.hint,
      command,
    }));
  }, [live, term, hidden]);

  const token = `${start ?? -1}:${term}`;
  const activeIndex =
    cursor.token === token ? Math.min(cursor.index, Math.max(0, options.length - 1)) : 0;

  return {
    // Nothing matching closes the menu, so Enter sends what was typed: "/etc" is a message.
    open: options.length > 0,
    options,
    activeIndex,
    start,
    refresh(text, caret) {
      const found = slashQueryAt(text, caret);
      setStart(found?.start ?? null);
      setTerm(found?.query ?? "");
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
      setCursor({ token, index: (activeIndex + delta + options.length) % options.length });
    },
    active() {
      return options[activeIndex] ?? null;
    },
  };
}
