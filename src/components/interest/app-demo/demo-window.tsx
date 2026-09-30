"use client";

import { useEffect, useReducer, useRef, useSyncExternalStore, type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Bell, MousePointerClick, RotateCcw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_HOUSE } from "@/lib/motion";
import { firstName, personById } from "./demo-cast";
import { DemoContext } from "./demo-context";
import { TourCursor, useDemoTour } from "./demo-cursor";
import { LogSheet, SearchPalette } from "./demo-overlays";
import { demoReducer, initialDemoState, type Screen } from "./demo-state";
import { TOUR } from "./demo-tour";
import { DemoSidebar } from "./demo-sidebar";
import { Avatar } from "./demo-ui";
import { ChatScreen } from "./screens/chat";
import { ConstellationScreen } from "./screens/constellation";
import { ContactProfileScreen } from "./screens/contact-profile";
import { ContactsScreen } from "./screens/contacts";
import { DashboardScreen } from "./screens/dashboard";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const SCREENS: Record<Screen, ComponentType> = {
  dashboard: DashboardScreen,
  contacts: ContactsScreen,
  profile: ContactProfileScreen,
  chat: ChatScreen,
  constellation: ConstellationScreen,
};

/** Screens that fill the pane (their own inner scroll) rather than scrolling as a page. */
const FILL: Screen[] = ["chat", "constellation"];

/**
 * The recreation: a window onto a made-up workspace. It plays `TOUR` until the visitor
 * interrupts it — pressing anything inside, or the "Explore it yourself" button — and then
 * every button works against `demoReducer`. "Replay tour" hands control back.
 */
export function DemoWindow() {
  const reduced = useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED_QUERY).matches, () => false);
  const [state, dispatch] = useReducer(demoReducer, undefined, () =>
    initialDemoState(window.matchMedia(REDUCED_QUERY).matches ? "explore" : "tour")
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const stateRef = useRef(state);
  const pausedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // The tour only spends time while the window is on screen and the tab is visible.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let onScreen = true;
    const update = () => {
      pausedRef.current = !onScreen || document.visibilityState === "hidden";
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = !!entry?.isIntersecting;
      update();
    }, { threshold: 0.3 });
    io.observe(root);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // Each screen starts at its top.
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [state.screen, state.profileId]);

  // Toasts clear themselves.
  useEffect(() => {
    if (!state.toast) return;
    const t = window.setTimeout(() => dispatch({ type: "toast", text: null }), 2600);
    return () => window.clearTimeout(t);
  }, [state.toast]);

  const touring = state.mode === "tour";
  const { cursor, pressing, beat, typed } = useDemoTour({ active: touring, reduced, rootRef, paneRef, pausedRef, stateRef, dispatch });

  /**
   * Any press or key inside the window — other than the mode button itself — hands the
   * visitor control. The press that does it still lands, so the first click is never wasted.
   * Scrolling the page past the widget does not count: only pointer-down and keys do.
   */
  const takeOver = (e: { target: EventTarget | null }) => {
    if (!touring) return;
    if (e.target instanceof Element && e.target.closest("[data-demo-modectl]")) return;
    dispatch({ type: "mode", mode: "explore" });
  };

  const Screen = SCREENS[state.screen];
  const fill = FILL.includes(state.screen);
  // On a profile the ask bar is about that person, as in the app: a chip above it says so, and
  // the question is theirs.
  const asked = state.screen === "profile" ? personById(state.profileId) : undefined;

  return (
    <DemoContext.Provider value={{ state, dispatch, reduced }}>
      <div
        ref={rootRef}
        onPointerDownCapture={takeOver}
        onKeyDownCapture={(e) => {
          takeOver(e);
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            dispatch({ type: "overlay", overlay: "palette" });
          }
          if (e.key === "Escape" && state.overlay) dispatch({ type: "overlay", overlay: null });
        }}
        className="dark relative h-[720px] overflow-hidden rounded-[22px] border border-white/12 bg-background text-left font-sans text-foreground shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.03)]"
      >
        <div aria-hidden="true" className="demo-starfield pointer-events-none absolute inset-0" />

        {/* Title bar */}
        <div className="relative flex h-10 items-center border-b border-white/[0.07] px-4">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-3 rounded-full bg-[#ff5f57]/85" />
            <span className="size-3 rounded-full bg-[#febc2e]/85" />
            <span className="size-3 rounded-full bg-[#28c840]/85" />
          </div>
          <p className="absolute left-1/2 -translate-x-1/2 text-xs text-muted-foreground">Orbit — preview</p>
          <div className="ml-auto" data-demo-modectl>
            {touring ? (
              <button
                type="button"
                onClick={() => dispatch({ type: "mode", mode: "explore" })}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-ink"
              >
                <MousePointerClick className="size-3.5" aria-hidden="true" />
                Explore it yourself
              </button>
            ) : (
              <button
                type="button"
                onClick={() => dispatch({ type: "mode", mode: "tour" })}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-ink"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {reduced ? "Play tour" : "Replay tour"}
              </button>
            )}
          </div>
        </div>

        <div className="relative flex h-[calc(100%-2.5rem)]">
          <DemoSidebar state={state} dispatch={dispatch} />
          <main ref={paneRef} className={cn("relative min-w-0 flex-1 overflow-y-auto pl-3 pt-6", fill ? "pr-4 pb-4" : "pr-16 pb-20")} aria-label="Demo app screen">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={state.screen === "profile" ? `profile-${state.profileId}` : state.screen}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.22, ease: EASE_HOUSE }}
                className={cn(fill ? "h-full" : "min-h-full")}
              >
                <Screen />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        {/* The app's floating controls: notifications at the top right, and the ask
            bar along the bottom of every screen that is not itself a chat or the star chart. */}
        <div className="absolute right-3 top-[3.25rem] z-30 flex flex-col gap-2.5">
          <button
            type="button"
            aria-label="Notifications"
            className="relative inline-flex size-10 items-center justify-center rounded-full border border-border bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
          >
            <Bell className="size-4" />
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
              3
            </span>
          </button>
        </div>
        {!fill && (
          <div className="absolute bottom-4 left-[calc(50%+4.5rem)] z-20 flex w-[340px] -translate-x-1/2 flex-col items-center gap-2">
            {asked && (
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/90 py-1 pl-1.5 pr-2 text-xs text-muted-foreground shadow-lg backdrop-blur">
                <Avatar person={asked} size={20} />
                <span>
                  Asking about <span className="text-ink">{asked.name}</span>
                </span>
                <X className="size-3" aria-hidden="true" />
              </span>
            )}
            <button
              type="button"
              data-demo-target={asked ? "profile-ask" : undefined}
              onClick={() =>
                asked
                  ? dispatch({
                      type: "ask",
                      q: asked.promise ? `What did I promise ${firstName(asked)}?` : `Where did I leave things with ${firstName(asked)}?`,
                    })
                  : dispatch({ type: "go", screen: "chat" })
              }
              className="flex w-full items-center gap-2.5 rounded-full border border-border bg-card/90 py-1.5 pl-4 pr-1.5 text-left shadow-xl backdrop-blur"
              aria-label={asked ? `Ask about ${asked.name}` : "Ask your network"}
            >
              <Search className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className={typed ? "flex-1 text-sm text-ink" : "flex-1 text-sm text-muted-foreground"}>{typed || "Ask your network…"}</span>
              <kbd className="rounded-md border border-border bg-muted/50 px-1.5 text-[11px] text-muted-foreground">⌘J</kbd>
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <ArrowUp className="size-4" aria-hidden="true" />
              </span>
            </button>
          </div>
        )}

        <AnimatePresence>
          {state.overlay === "palette" && <SearchPalette key="palette" />}
          {state.overlay === "log" && <LogSheet key="log" />}
        </AnimatePresence>

        <div className="pointer-events-none absolute bottom-4 right-4 z-40" aria-live="polite">
          <AnimatePresence>
            {state.toast && (
              <motion.p
                key={state.toast.id}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, y: 4 }}
                className="rounded-xl border border-border bg-popover/95 px-3.5 py-2 text-xs text-ink shadow-xl backdrop-blur"
              >
                {state.toast.text}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {touring && (
          <div
            className="absolute bottom-3 left-3 z-40 flex w-[280px] flex-col gap-2 rounded-2xl border border-tier-lifetime/30 bg-background/90 px-3.5 py-2.5 shadow-xl backdrop-blur"
          >
            <span className="flex shrink-0 gap-1" aria-hidden="true">
              {TOUR.map((_, i) => (
                <span key={i} className={cn("size-1.5 rounded-full", i === beat ? "bg-tier-lifetime" : i < beat ? "bg-tier-lifetime/45" : "bg-white/20")} />
              ))}
            </span>
            <span className="min-w-0 text-xs text-ink" aria-live="polite">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={beat}
                  className="block"
                  initial={reduced ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                >
                  {TOUR[beat]!.caption}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        )}

        {touring && cursor && <TourCursor at={cursor} pressing={pressing} reduced={reduced} />}
      </div>
    </DemoContext.Provider>
  );
}
