"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { isInternalBrowser, isTrackedPath } from "@/lib/analytics-redact";
import { readNavStart, waitForContent } from "@/lib/nav-timing";
import { PV_SESSION_KEY } from "@/lib/pageview-session";

/**
 * Reports one page view per navigation — with how long its content took to appear, the time
 * spent on it and, for the document's first view only, its Core Web Vitals (LCP, INP, CLS)
 * from Next's built-in `useReportWebVitals` — as a single `sendBeacon` when the visitor leaves.
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

/** The key is shared with the waitlist form (`src/lib/pageview-session.ts`), which reads it to link a join to its visit. */
const SESSION_KEY = PV_SESSION_KEY;

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

/**
 * One page view, from the moment it appears until the visitor is done with it.
 *
 * EVERYTHING ABOUT IT TRAVELS IN ONE REQUEST. The view's own fields, how long its content took
 * to appear, its Core Web Vitals and the time spent on it all wait here until the visitor leaves
 * (a route change, a tab switch, the page going away), then go out as a single beacon. They used
 * to be a request each — three or four serverless invocations per view, each with its own auth
 * and database write. `pending` holds the view's own fields until the first send; every later
 * send is an `update` that patches the same row.
 */
type View = {
  id: string;
  /** The Clerk flow this view belongs to, if any, so its later steps carry on with it. */
  flow: string | null;
  /** When the clock last started, or 0 while it is stopped. `accumulated` is what is banked. */
  since: number;
  accumulated: number;
  /** The view's insert, until a beacon carrying it has gone out. Null afterwards. */
  pending: Record<string, unknown> | null;
  load: { loadMs: number; navType: "hard" | "soft" } | null;
  /** The largest of each metric seen; the server keeps the largest too. */
  vitals: { lcpMs?: number; inpMs?: number; clsMilli?: number };
  /** Load or vitals changed since the last send. */
  dirty: boolean;
  /** The dwell the last send carried, so an unchanged view sends nothing at all. */
  sentDwell: number;
  /** Left for good (route change). Anything arriving after that has to send itself. */
  closed: boolean;
};

/** The last input, for the idle cut-off. */
let lastActivity = 0;

/** Bank the visible stretch and stop the clock. Idempotent. */
function settle(view: View) {
  if (view.since !== 0) {
    // Never past the idle cut-off: time after the last input plus the grace is not reading.
    const end = Math.min(Date.now(), lastActivity + IDLE_MS);
    view.accumulated += Math.max(0, end - view.since);
    view.since = 0;
  }
}

/**
 * Send a view's batch, unless nothing in it is new.
 *
 * SENDS THE RUNNING DWELL TOTAL, NOT A DELTA, and may fire several times for one view — once
 * per tab-away, once more on the way out. That is deliberate: there is no event that reliably
 * means "they are gone for good", so the only safe moment to report is every time they leave,
 * and the server keeps the largest figure it has seen. A visitor who reads, switches away,
 * comes back and reads more ends up with the sum of both stretches.
 */
function sendView(view: View) {
  const dwellMs = view.accumulated;
  if (!view.pending && !view.dirty && dwellMs <= view.sentDwell) return;
  const payload = {
    ...(view.pending ?? { kind: "update", id: view.id }),
    ...view.load,
    ...view.vitals,
    ...(dwellMs > 0 ? { dwellMs } : {}),
  };
  view.pending = null;
  view.dirty = false;
  view.sentDwell = dwellMs;
  post(payload);
}

/** A metric or load that lands once the visitor has already gone: nothing else will send it. */
function sendIfAway(view: View) {
  if (view.closed || document.visibilityState === "hidden") {
    settle(view);
    sendView(view);
  }
}

function post(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload);
    // A Blob rather than a bare string, so the request keeps its JSON content type —
    // sendBeacon defaults to text/plain, which the route would not parse. It also queues
    // past unload, which a fetch started on `pagehide` is not guaranteed to.
    if (
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon("/api/p/v", new Blob([body], { type: "application/json" }))
    ) {
      return;
    }
    // No sendBeacon, or its queue is full.
    void fetch("/api/p/v", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Blocked by an extension, offline, CSP. Nothing to do and nothing to report.
  }
}

/**
 * The document's FIRST view, the only one Core Web Vitals belong to: LCP is a property of a
 * document load, so a client-side navigation has none, and its INP and CLS are the document's
 * too. `firstRouteSeen` flips on the very first effect run whether or not that route is
 * tracked, so an /admin landing followed by a soft navigation into the app never claims the
 * vitals for that later view.
 */
let firstRouteSeen = false;
let firstView: View | null = null;

type WebVitalsCallback = Parameters<typeof useReportWebVitals>[0];

/**
 * Module-level, so its reference never changes: `useReportWebVitals` replays every metric so
 * far to each NEW callback it is handed. Each report carries the metric's current value; the
 * server keeps the largest per column (`recordVitals`), so the repeats are harmless.
 */
const reportVital: WebVitalsCallback = (metric) => {
  const view = firstView;
  if (!view) return;
  // A soft navigation's metrics, or a back/forward-cache restore's fresh ones, are not the
  // first document load's.
  const nav = (metric as { navigationType?: string }).navigationType;
  if (nav === "soft-navigation" || nav === "back-forward-cache") return;
  const value = metric.name === "CLS" ? Math.round(metric.value * 1000) : Math.round(metric.value);
  const key = metric.name === "LCP" ? "lcpMs" : metric.name === "INP" ? "inpMs" : metric.name === "CLS" ? "clsMilli" : null;
  if (!key) return;
  if (value > (view.vitals[key] ?? -1)) {
    view.vitals[key] = value;
    view.dirty = true;
  }
  // INP and CLS are final as the page hides, which can be just after the visibility handler
  // below has flushed — and a beacon is the only safe transport by then.
  sendIfAway(view);
};

export function PageviewBeacon() {
  const pathname = usePathname();
  useReportWebVitals(reportVital);
  /** The view currently on screen. */
  const open = useRef<View | null>(null);
  /** The view just left, so a step within the same sign-in flow can carry on with it. */
  const previous = useRef<View | null>(null);

  useEffect(() => {
    const isFirstRoute = !firstRouteSeen;
    firstRouteSeen = true;
    if (!pathname || !isTrackedPath(pathname)) return;

    const now = Date.now();
    const sid = sessionId(now);
    if (!sid) return;

    // Start the clock stopped if the page opened in a background tab (a middle-click, a
    // restored session). Otherwise every second it sat unseen counted as reading, and the
    // `visibilitychange` handler would not reset it because the clock was already running.
    const hidden = document.visibilityState === "hidden";
    lastActivity = now;

    // Leaving this route — either to another one, or out of the app entirely. This is the
    // one departure that really is final for this view.
    const leave = (view: View) => {
      settle(view);
      sendView(view);
      view.closed = true;
      previous.current = view;
      open.current = null;
    };

    // A later step of the sign-in or sign-up flow already on screen: keep timing that view.
    const flow = authFlowOf(pathname);
    const prior = previous.current;
    if (flow && prior && prior.flow === flow) {
      prior.closed = false;
      prior.since = hidden ? 0 : now;
      open.current = prior;
      return () => leave(prior);
    }

    const id = crypto.randomUUID();
    const referrer =
      documentReported || arrivedByReload() ? null : document.referrer || null;
    documentReported = true;

    // Null means this view is a document load rather than a client-side navigation.
    const navStart = readNavStart(pathname);

    const view: View = {
      id,
      flow,
      since: hidden ? 0 : now,
      accumulated: 0,
      pending: {
        kind: "view",
        id,
        sessionId: sid,
        path: pathname,
        // The full URL, so the server can read UTMs with the same parser the signup
        // attribution cookie uses. The server decides the stored route, not the client.
        url: window.location.href,
        referrer,
        // The view is sent when the visitor leaves it, so it says when it began: the server
        // dates the row and picks the day's visitor salt from this, not from the send.
        at: now,
        // "Don't count this browser", set from /admin/analytics.
        internal: isInternalBrowser(),
        automated: navigator.webdriver === true,
      },
      load: null,
      vitals: {},
      dirty: false,
      sentDwell: 0,
      closed: false,
    };
    open.current = view;
    if (isFirstRoute) firstView = view;

    // Page-load timing (`src/lib/nav-timing.ts`), carried by the view's own beacon.
    const measuring = new AbortController();
    void waitForContent(measuring.signal).then((readyAt) => {
      if (readyAt === null) return;
      view.load = { loadMs: readyAt - (navStart ?? 0), navType: navStart === null ? "hard" : "soft" };
      view.dirty = true;
      sendIfAway(view);
    });

    return () => {
      measuring.abort();
      leave(view);
    };
  }, [pathname]);

  useEffect(() => {
    // `pagehide` rather than `beforeunload`: it is the one that fires on iOS Safari and
    // when a page enters the back/forward cache. `visibilitychange` covers tab switches
    // and app backgrounding, which on mobile is how most sessions actually end.
    const flush = () => {
      const view = open.current;
      if (!view) return;
      settle(view);
      sendView(view);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Report what we have so far, but keep the view open — they may come back, and
        // clearing it here is what used to make "time on page" mean "time until the first
        // tab switch".
        flush();
      } else if (open.current && open.current.since === 0) {
        // Back on screen: restart the clock without losing what was already banked.
        const now = Date.now();
        lastActivity = now;
        open.current.since = now;
      }
    };
    // Any input restarts a clock the idle check stopped. Cheap enough to run on every
    // pointermove: two property writes, no allocation.
    const onActivity = () => {
      const now = Date.now();
      lastActivity = now;
      const current = open.current;
      if (current && current.since === 0 && document.visibilityState === "visible") {
        current.since = now;
      }
    };
    // Bank and stop the clock once the visitor has been idle past the grace. `settle` caps
    // the stretch at the last input plus the grace, so the check's own lateness adds nothing.
    const idleCheck = window.setInterval(() => {
      const current = open.current;
      if (current && current.since !== 0 && Date.now() - lastActivity > IDLE_MS) {
        settle(current);
      }
    }, 15_000);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { passive: true, capture: true });
    }
    return () => {
      window.clearInterval(idleCheck);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
    };
  }, []);

  return null;
}
