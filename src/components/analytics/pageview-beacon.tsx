"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { isInternalBrowser, isTrackedPath } from "@/lib/analytics-redact";
import { readNavStart, waitForContent } from "@/lib/nav-timing";

/**
 * Sends one page view per navigation, how long its content took to appear, and the time
 * spent on it when the page goes away.
 *
 * Mounted in the ROOT layout, so it covers marketing, auth, checkout and the product with
 * one instance. It must never import anything that reaches `@/db` — a client component
 * that does fails the build with a `node:fs` chunking error naming neither file.
 * `analytics-redact` is pure by construction for exactly this reason — and knows no routes,
 * because this ships to every page, the waitlist's own domain included.
 *
 * The session id lives in `sessionStorage`, NOT a cookie. It is per-tab, it dies when the
 * tab closes, it is never sent to another origin, and it exists only so the server can
 * group consecutive views into a session. That is what lets the whole pipeline stay
 * cookieless — see `src/lib/analytics-visitor.ts` for the visitor half.
 *
 * Every failure path here is a silent return. Analytics that breaks a page is worse than
 * no analytics.
 */

/** Neutral on purpose: storage keys are visible to anyone who opens devtools on the waitlist. */
const SESSION_KEY = "pv_sid";

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

/**
 * Whether this document arrived by reload or back/forward rather than a fresh navigation.
 *
 * Browsers keep the ORIGINAL `document.referrer` across a reload, so every F5 on a page
 * reached from Google recorded another Google referral. Only a fresh arrival is a referral.
 */
function arrivedByReload(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return nav?.type === "reload" || nav?.type === "back_forward";
  } catch {
    return false;
  }
}

/**
 * The Clerk flow a path belongs to, if any.
 *
 * `<SignIn>` and `<SignUp>` route every sub-step as a real pathname (`/sign-in/factor-one`,
 * `/sign-up/verify-email-address`, `/sso-callback`), and each is a new pathname to this
 * component — so one sign-in was recorded as two to four views of the same pattern. A step
 * within the flow the visitor is already in continues that view instead.
 */
function authFlowOf(path: string): string | null {
  for (const flow of ["/sign-in", "/sign-up"]) {
    if (path === flow || path.startsWith(`${flow}/`)) return flow;
  }
  return null;
}

/**
 * No input for this long and the visitor is treated as gone, even with the tab visible.
 *
 * `visibilityState` stays "visible" for a window buried behind other apps, on a second
 * monitor, or across a laptop sleep — so a pinned Orbit tab kept adding time until the
 * server's 30-minute clamp, and those clamped values piled up at the top of every average.
 * The clock stops at the last input plus this grace, and restarts on the next input.
 */
const IDLE_MS = 60_000;
const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const;

function post(payload: Record<string, unknown>, viaBeacon: boolean): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    if (viaBeacon && typeof navigator.sendBeacon === "function") {
      // A Blob rather than a bare string, so the request keeps its JSON content type —
      // sendBeacon defaults to text/plain, which the route would not parse.
      navigator.sendBeacon(
        "/api/track",
        new Blob([body], { type: "application/json" })
      );
      return Promise.resolve();
    }
    return fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).then(
      () => {},
      () => {}
    );
  } catch {
    // Blocked by an extension, offline, CSP. Nothing to do and nothing to report.
    return Promise.resolve();
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
  const open = useRef<{
    id: string;
    since: number;
    accumulated: number;
    /** The view's own insert request; a dwell sent before it lands would update nothing. */
    sent: Promise<void>;
    flow: string | null;
  } | null>(null);
  /** The view just left, so a step within the same sign-in flow can carry on with it. */
  const previous = useRef<{ id: string; accumulated: number; sent: Promise<void>; flow: string | null } | null>(null);
  /** The last input, for the idle cut-off. */
  const lastActivity = useRef(0);

  // Both of these touch nothing but the ref, so an empty dependency list makes them
  // genuinely stable for the life of the component — which is what lets the effects below
  // list `flush` honestly instead of suppressing the lint rule that asks for it.
  /** Bank the current visible stretch and stop the clock. Idempotent. */
  const settle = useCallback(() => {
    const current = open.current;
    if (!current) return null;
    if (current.since !== 0) {
      // Never past the idle cut-off: time after the last input plus the grace is not reading.
      const end = Math.min(Date.now(), lastActivity.current + IDLE_MS);
      current.accumulated += Math.max(0, end - current.since);
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
      const payload = { kind: "dwell", id: current.id, dwellMs: current.accumulated };
      if (viaBeacon) {
        // The page may be going away: `sendBeacon` now, or never.
        post(payload, true);
      } else {
        // A route change, so the page is staying and there is time to wait. A short visit's
        // dwell could otherwise overtake its own view's insert, update no row, and leave the
        // view with no time at all — the same race the `load` beacon already waits out.
        void current.sent.then(() => post(payload, false));
      }
    },
    [settle]
  );

  useEffect(() => {
    if (!pathname || !isTrackedPath(pathname)) return;

    const now = Date.now();
    const sid = sessionId(now);
    if (!sid) return;

    // Start the clock stopped if the page opened in a background tab (a middle-click, a
    // restored session). Otherwise every second it sat unseen counted as reading, and the
    // `visibilitychange` handler would not reset it because the clock was already running.
    const hidden = document.visibilityState === "hidden";
    lastActivity.current = now;

    // A later step of the sign-in or sign-up flow already on screen: keep timing that view.
    const flow = authFlowOf(pathname);
    const prior = previous.current;
    if (flow && prior && prior.flow === flow) {
      open.current = { ...prior, since: hidden ? 0 : now };
      return () => {
        flush(false);
        previous.current = open.current;
        open.current = null;
      };
    }

    const id = crypto.randomUUID();
    const referrer =
      documentReported || arrivedByReload() ? null : document.referrer || null;
    documentReported = true;

    // Null means this view is a document load rather than a client-side navigation.
    const navStart = readNavStart(pathname);

    const viewSent = post(
      {
        kind: "view",
        id,
        sessionId: sid,
        path: pathname,
        // The full URL, so the server can read UTMs with the same parser the signup
        // attribution cookie uses. The server decides the stored route, not the client.
        url: window.location.href,
        referrer,
        // "Don't count this browser", set from /admin/analytics.
        internal: isInternalBrowser(),
        automated: navigator.webdriver === true,
      },
      false
    );
    open.current = { id, since: hidden ? 0 : now, accumulated: 0, sent: viewSent, flow };

    // Page-load timing (`src/lib/nav-timing.ts`). The `load` beacon waits for the view's
    // own request to settle, because it UPDATEs the row that request inserts — sent first,
    // it would match nothing and the measurement would be lost without a trace.
    const measuring = new AbortController();
    void waitForContent(measuring.signal).then(async (readyAt) => {
      if (readyAt === null) return;
      const navType = navStart === null ? "hard" : "soft";
      const loadMs = readyAt - (navStart ?? 0);
      await viewSent;
      void post({ kind: "load", id, loadMs, navType }, false);
    });

    // Leaving this route — either to another one, or out of the app entirely. This is the
    // one departure that really is final for this view, so the ref is cleared after it.
    return () => {
      measuring.abort();
      flush(false);
      previous.current = open.current;
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
        const now = Date.now();
        lastActivity.current = now;
        open.current.since = now;
      }
    };
    // Any input restarts a clock the idle check stopped. Cheap enough to run on every
    // pointermove: two property writes, no allocation.
    const onActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      const current = open.current;
      if (current && current.since === 0 && document.visibilityState === "visible") {
        current.since = now;
      }
    };
    // Bank and stop the clock once the visitor has been idle past the grace. `settle` caps
    // the stretch at the last input plus the grace, so the check's own lateness adds nothing.
    const idleCheck = window.setInterval(() => {
      const current = open.current;
      if (current && current.since !== 0 && Date.now() - lastActivity.current > IDLE_MS) {
        settle();
      }
    }, 15_000);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { passive: true, capture: true });
    }
    return () => {
      window.clearInterval(idleCheck);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
    };
  }, [flush, settle]);

  return null;
}
