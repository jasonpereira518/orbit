"use client";

/**
 * How the real pages tell the coach rail "they did the thing". A one-line
 * `emitTourEvent("interaction.logged")` beside an existing success toast is the whole
 * contract; nothing here polls the database.
 *
 * A module-scope store read with `useSyncExternalStore` (never a plain module variable read
 * from a component — a subscriber added after an emit would otherwise miss it and read a
 * stale snapshot forever). The snapshot carries a sequence number so the same event twice
 * in a row is two changes, not one.
 */
import { useSyncExternalStore } from "react";

export const TOUR_EVENTS = {
  "contacts.searched": "contacts.searched",
  "interaction.logged": "interaction.logged",
  "reminder.done": "reminder.done",
  "chat.answered": "chat.answered",
  "graph.star-selected": "graph.star-selected",
} as const;

export type TourEventName = keyof typeof TOUR_EVENTS;

export type TourEventSnapshot = {
  seq: number;
  last: { name: TourEventName; at: number } | null;
};

const EMPTY: TourEventSnapshot = { seq: 0, last: null };
let snapshot: TourEventSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function emitTourEvent(name: TourEventName) {
  snapshot = { seq: snapshot.seq + 1, last: { name, at: Date.now() } };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

export function useTourEvents(): TourEventSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
