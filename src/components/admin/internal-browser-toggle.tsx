"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { INTERNAL_BROWSER_KEY, isInternalBrowser } from "@/lib/analytics-redact";

/**
 * "Don't count this browser" — the one way the operator's SIGNED-OUT visits to the landing
 * page can be kept out of the numbers. Signed-in admin views are excluded by account already;
 * a visit to `/` or `/pricing` in a private window has no account to filter by, so the beacon
 * marks it `internal` while this flag is set.
 *
 * Per browser, by design: it lives in `localStorage`, so set it once on each device you use.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function setInternal(value: boolean) {
  try {
    if (value) localStorage.setItem(INTERNAL_BROWSER_KEY, "1");
    else localStorage.removeItem(INTERNAL_BROWSER_KEY);
  } catch {
    // Storage blocked: nothing to persist, and the label below stays honest about it.
  }
  for (const listener of listeners) listener();
}

export function InternalBrowserToggle() {
  // `null` on the server and during hydration, so the first client render matches it.
  const internal = useSyncExternalStore(subscribe, isInternalBrowser, () => null);
  if (internal === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span>
        {internal
          ? "This browser is not counted, signed in or out."
          : "This browser is counted when you are signed out."}
      </span>
      <Button size="sm" variant="outline" onClick={() => setInternal(!internal)}>
        {internal ? "Count this browser again" : "Don't count this browser"}
      </Button>
    </div>
  );
}
