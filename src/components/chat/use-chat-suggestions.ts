"use client";

import { useEffect, useState } from "react";

import { getChatSuggestions } from "@/actions/chat";
import type { ChatSuggestion } from "@/lib/chat-suggestions";

/**
 * The composer's suggestion cards, fetched once per page load.
 *
 * Cached at module scope rather than per-hook because two surfaces show the same row: the
 * chat panel and the floating ask bar, which `AppShell` mounts on nearly every route. They
 * can be alive at the same moment, and the signals behind the row do not move fast enough
 * to be worth two round trips — or even a second one when you return to a new chat.
 *
 * Returns `null` while the fetch is in flight, so the caller can hold the row's height with
 * placeholders of the same size. That is not cosmetic: the composer footer is `shrink-0`
 * above a message list with `min-h-0 basis-0` and therefore no floor, so a row that grows
 * when data lands takes the height out of the thread.
 */
let cached: Promise<ChatSuggestion[]> | null = null;

export function useChatSuggestions(enabled: boolean): ChatSuggestion[] | null {
  const [items, setItems] = useState<ChatSuggestion[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // The action never throws — it falls back to the generic four — but a transport
    // failure still rejects, and an empty row beats a stuck placeholder.
    (cached ??= getChatSuggestions()).then(
      (rows) => {
        if (alive) setItems(rows);
      },
      () => {
        if (alive) setItems([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled]);

  return items;
}
