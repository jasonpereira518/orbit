"use client";
import { useSyncExternalStore } from "react";
import { createExternalStore } from "@/lib/create-external-store";
import type { PointStep } from "./pointing";

/**
 * Cosmo's pointing walk: the steps `point_at` planned and which one the cursor is on. The view
 * (CosmoPointer) moves it on as the person clicks; the call engine hears what happened through
 * `onPointingEvent` and tells the agent on its next tool result.
 */
export type Pointing = { steps: PointStep[]; index: number; id: number };

let state: Pointing | null = null;
let walks = 0;
const store = createExternalStore({ getSnapshot: () => state, getServerSnapshot: () => null });
const listeners = new Set<(event: { note: string; next: PointStep | null }) => void>();
const tell = (note: string, next: PointStep | null) => {
  for (const fn of listeners) fn({ note, next });
};

export function startPointing(steps: PointStep[]) {
  state = steps.length ? { steps, index: 0, id: ++walks } : null;
  store.emit();
}

/** The person clicked the current step's control: on to the next, or done. */
export function advancePointing() {
  if (!state) return;
  const step = state.steps[state.index];
  const next = state.steps[state.index + 1] ?? null;
  state = next ? { ...state, index: state.index + 1 } : null;
  store.emit();
  tell(`The user clicked the ${step.label}.`, next);
}

/** Stop pointing; `note` (if any) is what the agent hears about why. */
export function stopPointing(note?: string) {
  if (!state) return;
  state = null;
  store.emit();
  if (note) tell(note, null);
}

export function onPointingEvent(fn: (event: { note: string; next: PointStep | null }) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function usePointing(): Pointing | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
