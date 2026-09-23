"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useReducedMotionConfig } from "motion/react";
import { exitTour, finishTour, saveTourStop } from "@/actions/tour";
import { CoachRail } from "@/components/tour/coach-rail";
import { TourFinishCard } from "@/components/tour/tour-finish-card";
import { TourSpotlight } from "@/components/tour/tour-spotlight";
import { handOffToCapture } from "@/lib/capture-handoff";
import { useCaptureJob } from "@/lib/capture/job-store";
import { useCornerClearanceAbove } from "@/lib/corner-clearance";
import { friendlyError } from "@/lib/errors";
import { TOUR_EXAMPLE_NOTE } from "@/lib/onboarding-examples/cast";
import { overlayOpen } from "@/lib/overlay-open";
import { toast } from "@/lib/toast";
import { useTourEvents } from "@/lib/tour/tour-events";
import {
  isContactDetailPath,
  resolveTourStops,
  resumeTourStop,
  stopMatchesPath,
  stopPageLabel,
  type TourStop,
  type TourStopId,
} from "@/lib/tour/tour-stops";
import { RAIL_CARD_HEIGHT, RAIL_CARD_WIDTH, RAIL_EDGE, placeRail } from "@/lib/tour/rail-placement";
import { useAnchorRect } from "@/lib/tour/use-anchor-rect";
import { useMediaQuery } from "@/lib/use-media-query";

export type TourSeed = {
  stop: string | null;
  hasApiKey: boolean;
  linkedinRequested: boolean;
};

/** The pause between a tick appearing and the next stop, so the person sees what they did. */
const DONE_BEAT_MS = 1100;
/** How long the person must be off a stop's page before the rail offers the way back. */
const OFF_ROUTE_MS = 2500;
/** A push that has not changed the URL by then is pushed once more. */
const PUSH_RETRY_MS = 1800;
/** …and one that still has not is replaced by a full page load. */
const HARD_NAV_MS = 6000;
const VIEWPORT_LOCKED = new Set(["/chat", "/graph", "/reminders"]);
const EXTRACTED = new Set(["ready", "reviewing", "saving", "saved"]);

type CaptureSnapshot = { id: string; status: string } | null;

/** A stop whose prerequisite was skipped would wait for something that cannot appear. */
function reachable(stop: TourStop, completed: ReadonlySet<TourStopId>) {
  return !stop.requiresDone || completed.has(stop.requiresDone);
}

function isEditable(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * The in-app half of the guided tour. Mounted by AppShell only while the rail should be on
 * screen; the layout's props are a hydration seed, and everything live happens here. The
 * database is written fire-and-forget on every move so a reload or another tab resumes at
 * the same stop.
 */
export function TourRuntime({ seed, hidden }: { seed: TourSeed; hidden: ReadonlySet<string> }) {
  const router = useRouter();
  const pathname = usePathname();
  const reduced = useReducedMotionConfig();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [pending, start] = useTransition();

  const stops = useMemo(
    () => resolveTourStops({ hasApiKey: seed.hasApiKey, hidden, linkedinRequested: seed.linkedinRequested }),
    [seed.hasApiKey, hidden, seed.linkedinRequested],
  );
  const [stopId, setStopId] = useState<TourStopId>(() => resumeTourStop(seed.stop, stops).id);
  const index = Math.max(0, stops.findIndex((s) => s.id === stopId));
  const stop: TourStop = stops[index] ?? stops[0];
  const total = stops.length;
  const [completed, setCompleted] = useState<ReadonlySet<TourStopId>>(() => new Set());
  const [done, setDone] = useState(false);
  const [closed, setClosed] = useState(false);
  const [dialogUp, setDialogUp] = useState(false);
  const [offRoute, setOffRoute] = useState(false);
  const [sidebarRight, setSidebarRight] = useState(0);
  // null = follow the placement (collapse when the card would sit on the anchor's centre);
  // a click on the pill or the chevron overrides it until the next stop.
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(null);

  const onRoute = stopMatchesPath(stop, pathname);
  const isFinish = stop.id === "finish";
  // A stop already done once (the person came Back to it) shows its tick and waits for Next.
  // Re-running its predicate would bounce them straight forward again: on a profile the
  // "open a person" stop is instantly true, and a ready capture job instantly "extracted".
  const alreadyDone = completed.has(stop.id);

  // The profile the person last opened, so the log stop can take them back to it after they
  // wander off (browser Back, the sidebar) instead of dropping them on the list.
  // Adjusted during render (React's "derive from a changed input" pattern), not an effect.
  const [lastProfile, setLastProfile] = useState<string | null>(null);
  if (isContactDetailPath(pathname) && lastProfile !== pathname) setLastProfile(pathname);

  // Events count only from the moment a stop is entered: `armedSeq` is set in `go` (an event
  // handler, where a ref may be written) from the latest sequence an effect mirrored.
  const events = useTourEvents();
  const latestSeq = useRef(0);
  useEffect(() => {
    latestSeq.current = events.seq;
  }, [events.seq]);
  const armedSeq = useRef(0);

  // The capture job as it stood when the stop was entered. The capture predicates read a
  // store that outlives stops (and tours), so only a change since arriving counts: an old
  // job already `saved`, or a Back onto the extract stop with a job `ready`, is not news.
  const capture = useCaptureJob();
  const captureStatus = capture.job?.status ?? null;
  const captureId = capture.job?.id ?? null;
  const latestCapture = useRef<CaptureSnapshot>(null);
  useEffect(() => {
    latestCapture.current = captureId && captureStatus ? { id: captureId, status: captureStatus } : null;
  }, [captureId, captureStatus]);
  const captureAtEntry = useRef<CaptureSnapshot | undefined>(undefined);
  // "Opened a profile" means arriving on one after being somewhere else since the stop began.
  // Entering a stop while already on a profile (Back pressed twice, or a push still in
  // flight) must not count as opening it.
  const offProfileSinceEntry = useRef(!isContactDetailPath(pathname));
  useEffect(() => {
    if (!isContactDetailPath(pathname)) offProfileSinceEntry.current = true;
  }, [pathname]);

  // ---- moving between stops -------------------------------------------------------------
  const go = useCallback(
    (next: TourStopId) => {
      armedSeq.current = latestSeq.current;
      captureAtEntry.current = latestCapture.current;
      offProfileSinceEntry.current = !isContactDetailPath(window.location.pathname);
      setStopId(next);
      setDone(false);
      setOffRoute(false);
      setCollapsedChoice(null);
      void saveTourStop(next)
        .then((res) => {
          if (!res.ok) console.error(`Tour stop "${next}" was rejected by the server.`);
        })
        .catch((err) => console.error(`Failed to persist tour stop "${next}"`, err));
    },
    [],
  );
  const next = useCallback(() => {
    const following = stops.slice(index + 1).find((s) => reachable(s, completed));
    if (following) go(following.id);
  }, [completed, go, index, stops]);
  const back = useCallback(() => {
    const previous = stops.slice(0, index).reverse().find((s) => reachable(s, completed));
    if (previous) go(previous.id);
  }, [completed, go, index, stops]);

  const goThere = useCallback(() => {
    if (stop.route.includes(":")) {
      router.push(lastProfile ?? "/contacts");
      return;
    }
    if (stop.onEnter === "prefill-capture-note") handOffToCapture(TOUR_EXAMPLE_NOTE);
    router.push(stop.route);
  }, [lastProfile, router, stop]);

  // On a new stop, navigate to its page once and prefetch the one after it. The profile stop
  // goes back to the profile they last opened; the first time, their own click gets there.
  const navigatedFor = useRef<TourStopId | null>(null);
  // When the tour last pushed, so the off-route card does not appear over its own
  // navigation while the next page is still loading.
  const pushedAt = useRef(0);
  useEffect(() => {
    if (navigatedFor.current === stop.id) return;
    navigatedFor.current = stop.id;
    const following = stops[index + 1];
    if (following && !following.route.includes(":")) router.prefetch(following.route);
    if (stopMatchesPath(stop, pathname)) return;
    // The profile stop is a pattern the tour cannot invent; it can only return to the one
    // they opened. With none yet, the rail asks them to open someone.
    const target = stop.route.includes(":") ? lastProfile : stop.route;
    if (!target) return;
    if (stop.onEnter === "prefill-capture-note") handOffToCapture(TOUR_EXAMPLE_NOTE);
    pushedAt.current = Date.now();
    router.push(target);
    // A page that refreshes the router or rewrites its own URL from an effect can make Next
    // drop a navigation still in flight. One more push a moment later usually lands; if even
    // that has not moved the address bar, a full load does — the stop is already saved
    // server-side, so the rail comes back exactly here.
    const retry = window.setTimeout(() => {
      if (window.location.pathname !== target) router.push(target);
    }, PUSH_RETRY_MS);
    const hard = window.setTimeout(() => {
      if (window.location.pathname !== target) window.location.assign(target);
    }, HARD_NAV_MS);
    return () => {
      window.clearTimeout(retry);
      window.clearTimeout(hard);
    };
  }, [index, lastProfile, pathname, router, stop, stops]);

  // The off-route card waits a moment so the tour's own navigation never flashes it.
  useEffect(() => {
    const sincePush = Date.now() - pushedAt.current;
    const wait = onRoute ? 0 : sincePush < HARD_NAV_MS ? HARD_NAV_MS - sincePush + OFF_ROUTE_MS : OFF_ROUTE_MS;
    const t = window.setTimeout(() => setOffRoute(!onRoute), wait);
    return () => window.clearTimeout(t);
  }, [onRoute, stop.id]);

  // ---- predicates -----------------------------------------------------------------------
  useEffect(() => {
    // The stop the tour resumed at on load was never entered through `go`: its baseline is
    // the job as the page first saw it.
    if (captureAtEntry.current === undefined) {
      captureAtEntry.current = captureId && captureStatus ? { id: captureId, status: captureStatus } : null;
    }
  }, [captureId, captureStatus]);

  useEffect(() => {
    if (done || alreadyDone || !stop.doneWhen) return;
    const entry = captureAtEntry.current ?? null;
    const sameJob = entry != null && entry.id === captureId;
    let satisfied = false;
    // Opening a profile from the search stop skips "open a person" too: it is done, and the
    // list it would point at is no longer on screen.
    let skipTo: TourStopId | null = null;
    switch (stop.doneWhen) {
      case "route:contact-detail":
        // The stop itself lives on /contacts; what completes it is arriving on a profile.
        satisfied = isContactDetailPath(pathname) && offProfileSinceEntry.current;
        break;
      case "capture.extracted":
        satisfied = captureStatus != null && EXTRACTED.has(captureStatus) && !(sameJob && EXTRACTED.has(entry.status));
        break;
      case "capture.saved":
        satisfied = captureStatus === "saved" && !(sameJob && entry.status === "saved");
        break;
      default:
        satisfied = events.seq > armedSeq.current && events.last?.name === stop.doneWhen;
        if (!satisfied && stop.id === "contacts.search" && isContactDetailPath(pathname) && offProfileSinceEntry.current) {
          const open = stops.find((s) => s.id === "contacts.open");
          const log = stops.find((s) => s.id === "contact.log");
          if (open && log) skipTo = log.id;
        }
    }
    if (skipTo) {
      const target = skipTo;
      const from = stop.id;
      const t = window.setTimeout(() => {
        setCompleted((c) => new Set([...c, from, "contacts.open"]));
        go(target);
      }, 0);
      return () => window.clearTimeout(t);
    }
    if (!satisfied) return;
    const id = stop.id;
    // Async by construction: the beat is what lets the person see the tick.
    const t = window.setTimeout(
      () => {
        setDone(true);
        setCompleted((c) => (c.has(id) ? c : new Set([...c, id])));
      },
      0,
    );
    return () => window.clearTimeout(t);
  }, [alreadyDone, captureId, captureStatus, done, events.last?.name, events.seq, go, pathname, stop, stops]);

  // Once done, advance after the beat (instantly under reduced motion).
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(next, reduced ? 0 : DONE_BEAT_MS);
    return () => window.clearTimeout(t);
  }, [done, next, reduced]);

  // ---- the spotlight --------------------------------------------------------------------
  useEffect(() => {
    const check = () => setDialogUp(overlayOpen());
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style", "data-state"] });
    const t = window.setTimeout(check, 0);
    return () => {
      mo.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  const anchor = useAnchorRect(onRoute && !closed ? stop.anchor : null, stop.id);
  const missing = onRoute && stop.anchor != null && anchor.status === "missing";

  // Focus the control when the stop asks for it, and bring it into view, once per stop.
  const settledFor = useRef<TourStopId | null>(null);
  useEffect(() => {
    if (!anchor.el || settledFor.current === stop.id) return;
    settledFor.current = stop.id;
    const el = anchor.el;
    const r = el.getBoundingClientRect();
    const partlyOff = r.top < 0 || r.bottom > window.innerHeight;
    if (partlyOff && getComputedStyle(el).position !== "fixed") {
      el.scrollIntoView({
        block: VIEWPORT_LOCKED.has(pathname) ? "nearest" : "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
    if (stop.focusAnchor) {
      const target = el.matches("input, textarea, [contenteditable]")
        ? el
        : el.querySelector<HTMLElement>("input, textarea, [contenteditable]");
      target?.focus({ preventScroll: true });
    }
  }, [anchor.el, pathname, stop.focusAnchor, stop.id]);

  // ---- placement ------------------------------------------------------------------------
  useEffect(() => {
    const el = document.querySelector<HTMLElement>("[data-app-sidebar]");
    if (!el) return;
    const measure = () => setSidebarRight(el.getBoundingClientRect().right);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const t = window.setTimeout(measure, 0);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  const desktopRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  // The expanded card's real size, which the placement needs (the estimate is only for the
  // frame before it is measured). Measured only while expanded: measuring the pill would
  // make the card look small enough to expand, which would make it big enough to collapse.
  const [expandedSize, setExpandedSize] = useState({ width: RAIL_CARD_WIDTH, height: RAIL_CARD_HEIGHT });
  const collapsedRef = useRef(false);
  useEffect(() => {
    const el = desktopRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (collapsedRef.current) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setExpandedSize((s) =>
        Math.abs(s.width - r.width) < 1 && Math.abs(s.height - r.height) < 1 ? s : { width: r.width, height: r.height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cardLeft = sidebarRight + RAIL_EDGE;
  const placement = placeRail(
    onRoute ? anchor.rect : null,
    typeof window === "undefined" ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight },
    cardLeft,
    expandedSize,
  );
  const flipped = placement.flipped;
  const collapsed = collapsedChoice ?? placement.coversCenter;
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);
  useCornerClearanceAbove(desktopRef, isDesktop && flipped && !closed);
  useCornerClearanceAbove(phoneRef, !isDesktop && !closed);

  // ---- keyboard -------------------------------------------------------------------------
  const handlers = useRef({ next, back });
  useEffect(() => {
    handlers.current = { next, back };
  }, [next, back]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target) || overlayOpen()) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        handlers.current.next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlers.current.back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the rail's heading once on the handoff, so keyboard and screen-reader users know
  // it is there. Later stop changes leave focus where the person put it.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current) return;
    focusedOnce.current = true;
    const t = window.setTimeout(() => {
      (isDesktop ? desktopRef.current : phoneRef.current)?.focus({ preventScroll: true });
    }, 300);
    return () => window.clearTimeout(t);
  }, [isDesktop]);

  // ---- leaving --------------------------------------------------------------------------
  // Both end with a full load rather than `router.refresh()`: the example people, the rail,
  // the ask bar and the checklist card all change at once, and a client refresh racing a
  // page's own refresh has been seen to leave the old tree (and the old URL) in place.
  const exit = () => {
    setClosed(true);
    start(async () => {
      try {
        await exitTour();
      } finally {
        window.location.reload();
      }
    });
  };
  const finish = () => {
    setClosed(true);
    start(async () => {
      try {
        const res = await finishTour();
        // No toast here: the full load below would cut it off, and the finish card and the
        // dashboard's checklist already say what happened.
        window.location.assign(res.redirectTo);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t finish the tour — try again?"));
        setClosed(false);
      }
    });
  };

  if (closed) return null;

  const spotlightVisible = onRoute && !dialogUp && !isFinish && anchor.status === "found";

  return (
    <>
      <TourSpotlight rect={anchor.rect} chip={stop.chip} visible={spotlightVisible} />
      <CoachRail
        ref={desktopRef}
        phoneRef={phoneRef}
        desktopStyle={flipped ? {} : { left: cardLeft }}
        flipped={flipped}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsedChoice(!collapsed)}
        stop={stop}
        index={index}
        total={total}
        done={done || alreadyDone || !stop.doneWhen}
        missing={missing}
        offRoute={
          offRoute && !isFinish
            ? stop.route.includes(":") && !lastProfile
              ? { page: stopPageLabel(stop), message: "Open anyone’s profile from Contacts to carry on.", canGo: pathname !== "/contacts" }
              : { page: stopPageLabel(stop), canGo: true }
            : null
        }
        pending={pending}
        onBack={index > 0 ? back : null}
        onNext={isFinish ? finish : next}
        onGoThere={goThere}
        onExit={exit}
        finish={
          isFinish ? (
            <TourFinishCard
              facts={{ hasApiKey: seed.hasApiKey, linkedinRequested: seed.linkedinRequested, completed }}
              pending={pending}
              onFinish={finish}
            />
          ) : undefined
        }
      />
      <p className="sr-only" aria-live="polite">
        {done && stop.doneLabel
          ? `Done: ${stop.doneLabel.done}`
          : `Stop ${index + 1} of ${total}: ${stop.title}.${stop.tryThis ? ` Try this: ${stop.tryThis}` : ""}`}
      </p>
    </>
  );
}
