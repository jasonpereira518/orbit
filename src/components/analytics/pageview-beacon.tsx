"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { isTrackedPath } from "@/lib/analytics-routes";

/**
 * Sends one page view per navigation, and the time spent on it when the page goes away.
 *
 * Mounted in the ROOT layout, so it covers marketing, auth, checkout and the product with
 * one instance. It must never import anything that reaches `@/db` — a client component
 * that does fails the build with a `node:fs` chunking error naming neither file.
 * `analytics-routes` is pure by construction for exactly this reason.
 *
 * The session id lives in `sessionStorage`, NOT a cookie. It is per-tab, it dies when the
 * tab closes, it is never sent to another origin, and it exists only so the server can
 * group consecutive views into a session. That is what lets the whole pipeline stay
 * cookieless — see `src/lib/analytics-visitor.ts` for the visitor half.
 *
 * Every failure path here is a silent return. Analytics that breaks a page is worse than
 * no analytics.
 */

const SESSION_KEY = "orbit_sid";

/**
 * A session ends after this long with no page view — the conventional 30 minutes.
 *
 * Without it a session is the lifetime of the TAB, and for a CRM that is the wrong unit:
 * people pin Orbit and come back to it every morning, which made one tab a single
 * multi-day "session" and pushed the median session length into days.
 */
const SESSION_IDLE_MS = 30 * 60_000;

function sessionId(now: number): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    let stored: { id?: unknown; at?: unknown } | null = null;
    if (raw) {
      try {
        stored = JSON.parse(raw) as { id?: unknown; at?: unknown };
      } catch {
        // A bare id from before the idle timeout existed. Treat it as expired.
      }
    }
    const fresh =
      typeof stored?.id === "string" &&
      typeof stored?.at === "number" &&
      now - stored.at < SESSION_IDLE_MS;
    const id = fresh ? (stored!.id as string) : crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, at: now }));
    return id;
  } catch {
    // Private mode, storage disabled, or a sandboxed frame. No session, no tracking.
    return null;
  }
}

/**
 * Whether this document has already reported a view.
 *
 * `document.referrer` is fixed for the life of the document — client-side navigation
 * never updates it — so sending it with every view credited the landing referrer with
 * every page of the visit. Only the first view of a document carries it.
 */
let documentReported = false;

function post(payload: Record<string, unknown>, viaBeacon: boolean): void {
  try {
    const body = JSON.stringify(payload);
    if (viaBeacon && typeof navigator.sendBeacon === "function") {
      // A Blob rather than a bare string, so the request keeps its JSON content type —
      // sendBeacon defaults to text/plain, which the route would not parse.
      navigator.sendBeacon(
        "/api/track",
        new Blob([body], { type: "application/json" })
      );
      return;
    }
    void fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Blocked by an extension, offline, CSP. Nothing to do and nothing to report.
  }
}

export function PageviewBeacon() {
  const pathname = usePathname();
  /**
   * The view currently on screen.
   *
   * `since` is when the clock last started, or 0 while it is stopped — a visitor who
   * switches tabs stops accruing time, and starts again when they come back.
   * `accumulated` is everything banked from earlier visible stretches.
   */
  const open = useRef<{ id: string; since: number; accumulated: number } | null>(null);

  // Both of these touch nothing but the ref, so an empty dependency list makes them
  // genuinely stable for the life of the component — which is what lets the effects below
  // list `flush` honestly instead of suppressing the lint rule that asks for it.
  /** Bank the current visible stretch and stop the clock. Idempotent. */
  const settle = useCallback(() => {
    const current = open.current;
    if (!current) return null;
    if (current.since !== 0) {
      current.accumulated += Date.now() - current.since;
      current.since = 0;
    }
    return current;
  }, []);

  /**
   * Report time on the current page.
   *
   * SENDS THE RUNNING TOTAL, NOT A DELTA, and may fire several times for one view — once
   * per tab-away, once more on the way out. That is deliberate: there is no event that
   * reliably means "they are gone for good", so the only safe moment to report is every
   * time they leave, and the server keeps the largest figure it has seen. A visitor who
   * reads, switches away, comes back and reads more ends up with the sum of both stretches
   * instead of just the first, which is what the earlier one-shot version recorded.
   */
  const flush = useCallback(
    (viaBeacon: boolean) => {
      const current = settle();
      if (!current || current.accumulated <= 0) return;
      post(
        { kind: "dwell", id: current.id, dwellMs: current.accumulated },
        viaBeacon
      );
    },
    [settle]
  );

  useEffect(() => {
    if (!pathname || !isTrackedPath(pathname)) return;

    const now = Date.now();
    const sid = sessionId(now);
    if (!sid) return;

    const id = crypto.randomUUID();
    // Start the clock stopped if the page opened in a background tab (a middle-click, a
    // restored session). Otherwise every second it sat unseen counted as reading, and the
    // `visibilitychange` handler would not reset it because the clock was already running.
    const hidden = document.visibilityState === "hidden";
    open.current = { id, since: hidden ? 0 : now, accumulated: 0 };

    const referrer = documentReported ? null : document.referrer || null;
    documentReported = true;

    post(
      {
        kind: "view",
        id,
        sessionId: sid,
        path: pathname,
        // The full URL, so the server can read UTMs with the same parser the signup
        // attribution cookie uses. The server decides the stored route, not the client.
        url: window.location.href,
        referrer,
      },
      false
    );

    // Leaving this route — either to another one, or out of the app entirely. This is the
    // one departure that really is final for this view, so the ref is cleared after it.
    return () => {
      flush(true);
      open.current = null;
    };
  }, [pathname, flush]);

  useEffect(() => {
    // `pagehide` rather than `beforeunload`: it is the one that fires on iOS Safari and
    // when a page enters the back/forward cache. `visibilitychange` covers tab switches
    // and app backgrounding, which on mobile is how most sessions actually end.
    const onHide = () => flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Report what we have so far, but keep the view open — they may come back, and
        // clearing it here is what used to make "time on page" mean "time until the first
        // tab switch".
        flush(true);
      } else if (open.current && open.current.since === 0) {
        // Back on screen: restart the clock without losing what was already banked.
        open.current.since = Date.now();
      }
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  return null;
}
