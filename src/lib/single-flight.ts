"use client";

/**
 * One save at a time, enforced where the save starts.
 *
 * A Save button's `disabled={pending}` only takes effect on the next render, so it cannot stop a
 * second activation that arrives before React has committed: two clicks in one tick, Enter held
 * down, a form submitted twice. And it never links two different triggers of the same save: a
 * field that saves on Enter and again on blur, an autosave-on-blur next to a Save button. Each
 * path sees its own `pending` false and runs. (The toast layer collapses the duplicate message
 * (`lib/toast.tsx`), but the action itself still ran twice on the server.)
 *
 * The lock here is a plain flag read and written synchronously, so the second call is refused
 * the instant it is made, whichever path it came from.
 */
import { useCallback, useRef, useTransition, type TransitionStartFunction } from "react";

type Thenable = { then: (onFulfilled: () => void, onRejected: (reason: unknown) => void) => unknown };

function isThenable(value: unknown): value is Thenable {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** The lock itself, free of React so a smoke can drive it. */
export function createSingleFlight() {
  let busy = false;
  return {
    /** True while a run is in flight. */
    get busy() {
      return busy;
    },
    /**
     * Run `fn` unless one is already in flight, in which case `undefined` and nothing runs.
     * Released when `fn` settles (a returned promise) or returns (anything else), and also when
     * it throws, so a failed save can be tried again.
     */
    run<T>(fn: () => T): T | undefined {
      if (busy) return undefined;
      busy = true;
      let result: T;
      try {
        result = fn();
      } catch (err) {
        busy = false;
        throw err;
      }
      if (isThenable(result)) {
        // Both outcomes release; the caller still sees the original promise and its rejection.
        result.then(
          () => {
            busy = false;
          },
          () => {
            busy = false;
          }
        );
      } else {
        busy = false;
      }
      return result;
    },
  };
}

/**
 * `useSingleFlight()` — for a save with more than one trigger. Every trigger goes through the
 * same `run`, so Enter-then-blur, or blur-then-click, saves once:
 *
 *   const flight = useSingleFlight();
 *   const commit = () => flight.run(() => rename(id, title));
 */
export function useSingleFlight() {
  const ref = useRef<ReturnType<typeof createSingleFlight> | null>(null);
  if (ref.current === null) ref.current = createSingleFlight();
  const flight = ref.current;
  const run = useCallback(<T,>(fn: () => T) => flight.run(fn), [flight]);
  return { run, isBusy: () => flight.busy };
}

/**
 * A drop-in for `useTransition()` whose `start` refuses a second call while the first is still
 * in flight. Same `[pending, start]`, so a save component changes by its import and one line:
 *
 *   const [pending, start] = useGuardedTransition();
 *
 * `pending` still drives the button's `disabled` and its "Saving…" label. This adds the part it
 * cannot do: closing the gap before that disabled state commits.
 *
 * The callback's own return value is handed to React untouched (an async save stays an async
 * action), so updates inside it behave exactly as they did under `useTransition`.
 */
export function useGuardedTransition(): [boolean, TransitionStartFunction] {
  const [pending, startTransition] = useTransition();
  const ref = useRef<ReturnType<typeof createSingleFlight> | null>(null);
  if (ref.current === null) ref.current = createSingleFlight();
  const flight = ref.current;
  const start = useCallback<TransitionStartFunction>(
    (callback) => {
      if (flight.busy) return;
      startTransition(() => flight.run(callback));
    },
    [flight]
  );
  return [pending, start];
}
