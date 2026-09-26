"use client";

import { useEffect, useReducer, useRef, useSyncExternalStore, type ComponentType, type Dispatch } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LayoutDashboard, MessageSquare, MousePointerClick, Network, Plus, RotateCcw, Search, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_HOUSE } from "@/lib/motion";
import { DemoContext } from "./demo-context";
import { TourCursor, useDemoTour } from "./demo-cursor";
import { LogSheet, SearchPalette } from "./demo-overlays";
import { demoReducer, initialDemoState, type DemoAction, type DemoState, type Screen } from "./demo-state";
import { TOUR } from "./demo-tour";
import { BTN_PRIMARY, DEMO_TOKENS } from "./demo-ui";
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

const NAV: { screen: Exclude<Screen, "profile">; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { screen: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { screen: "contacts", label: "Contacts", icon: Users },
  { screen: "chat", label: "Chat", icon: MessageSquare },
  { screen: "constellation", label: "Constellation", icon: Network },
];

const SCREENS: Record<Screen, ComponentType> = {
  dashboard: DashboardScreen,
  contacts: ContactsScreen,
  profile: ContactProfileScreen,
  chat: ChatScreen,
  constellation: ConstellationScreen,
};

/** Screens that fill the pane (their own inner scroll) rather than scrolling as a page. */
const FILL: Screen[] = ["chat", "constellation"];

function Sidebar({ state, dispatch }: { state: DemoState; dispatch: Dispatch<DemoAction> }) {
  const active = state.screen === "profile" ? "contacts" : state.screen;
  return (
    <aside className="h-full w-56 shrink-0 p-3">
      <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-[linear-gradient(165deg,rgba(43,57,86,0.72),rgba(26,36,56,0.55),rgba(14,21,36,0.48))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <div className="flex items-center gap-2.5 px-1">
          {/* A plain img: the waitlist host serves /waitlist/ and nothing else, and next/image's optimizer would ask for more. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/waitlist/logo.png" alt="" width={30} height={30} className="size-[30px] rounded-full" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="font-[family-name:var(--font-display)] text-lg text-[var(--d-primary)]">Orbit</p>
            <p className="text-[11px] text-[var(--d-dim)]">Network tracker</p>
          </div>
          <button
            type="button"
            aria-label="Search your network"
            onClick={() => dispatch({ type: "overlay", overlay: "palette" })}
            className="inline-flex size-8 items-center justify-center rounded-full border border-white/15 text-[var(--d-dim)] hover:text-[var(--d-ink)]"
          >
            <Search className="size-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => dispatch({ type: "overlay", overlay: "log", logFor: state.screen === "profile" ? state.profileId : null })}
          className={cn(BTN_PRIMARY, "mt-4 w-full rounded-xl py-2 text-sm")}
        >
          <Plus className="size-4" aria-hidden="true" />
          Log interaction
        </button>

        <nav className="mt-4 space-y-0.5" aria-label="Demo app">
          {NAV.map(({ screen, label, icon: Icon }) => (
            <button
              key={screen}
              type="button"
              data-demo-target={`nav-${screen}`}
              aria-current={active === screen ? "page" : undefined}
              onClick={() => dispatch({ type: "go", screen })}
              className={cn(
                "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
                active === screen ? "text-[var(--d-ink)]" : "text-[var(--d-dim)] hover:text-[var(--d-ink)]"
              )}
            >
              {active === screen && (
                <motion.span
                  layoutId="demo-nav-pill"
                  className="absolute inset-0 rounded-xl bg-white/10 ring-1 ring-white/10"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              <Icon className="relative size-4" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-auto flex items-center gap-2.5 border-t border-white/10 px-1 pt-3">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-[#f2c14e]/20 text-[11px] font-medium text-[#f2c14e]">
            You
          </span>
          <span className="text-xs text-[var(--d-dim)]">Account</span>
        </div>
      </div>
    </aside>
  );
}

/**
 * The recreation: a window onto a made-up workspace. It plays `TOUR` and is look-only
 * until the visitor presses "Explore it yourself" — then every button works against
 * `demoReducer`. Nothing else hands over control: a stray click never breaks the tour.
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
  const { cursor, pressing, beat } = useDemoTour({ active: touring, reduced, rootRef, paneRef, pausedRef, stateRef, dispatch });

  const Screen = SCREENS[state.screen];
  const fill = FILL.includes(state.screen);

  return (
    <DemoContext.Provider value={{ state, dispatch, reduced }}>
      <div
        ref={rootRef}
        style={DEMO_TOKENS}
        onKeyDownCapture={(e) => {
          if (touring) return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            dispatch({ type: "overlay", overlay: "palette" });
          }
          if (e.key === "Escape" && state.overlay) dispatch({ type: "overlay", overlay: null });
        }}
        className="relative h-[640px] overflow-hidden rounded-[22px] border border-white/12 bg-[var(--d-bg)] text-left font-sans text-[var(--d-ink)] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.03)]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(900px 500px at 100% 0%, rgba(104,96,214,0.16), transparent 60%), radial-gradient(700px 500px at 0% 100%, rgba(46,122,158,0.14), transparent 60%)",
          }}
        />

        {/* Title bar */}
        <div className="relative flex h-10 items-center border-b border-white/[0.07] px-4">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-3 rounded-full bg-[#ff5f57]/85" />
            <span className="size-3 rounded-full bg-[#febc2e]/85" />
            <span className="size-3 rounded-full bg-[#28c840]/85" />
          </div>
          <p className="absolute left-1/2 -translate-x-1/2 text-xs text-[var(--d-dim)]">Project: Orbit — preview</p>
          <div className="ml-auto">
            {touring ? (
              <button
                type="button"
                onClick={() => dispatch({ type: "mode", mode: "explore" })}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[11px] text-[var(--d-dim)] hover:text-[var(--d-ink)]"
              >
                <MousePointerClick className="size-3.5" aria-hidden="true" />
                Explore it yourself
              </button>
            ) : (
              <button
                type="button"
                onClick={() => dispatch({ type: "mode", mode: "tour" })}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[11px] text-[var(--d-dim)] hover:text-[var(--d-ink)]"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {reduced ? "Play tour" : "Replay tour"}
              </button>
            )}
          </div>
        </div>

        {/* While the tour plays the app is look-only: `inert` drops clicks, keys, focus and
            scrolling, so the only way in is the "Explore it yourself" button above. */}
        <div className="relative flex h-[calc(100%-2.5rem)]" inert={touring}>
          <Sidebar state={state} dispatch={dispatch} />
          <main ref={paneRef} className="relative min-w-0 flex-1 overflow-y-auto px-6 pb-4 pt-6 pr-7" aria-label="Demo app screen">
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
                className="rounded-xl border border-white/12 bg-[#212c42]/95 px-3.5 py-2 text-xs text-[var(--d-ink)] shadow-xl backdrop-blur"
              >
                {state.toast.text}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {touring && (
          <div
            className="absolute bottom-4 left-[calc(50%+7rem)] z-40 flex max-w-[520px] -translate-x-1/2 items-center gap-3 rounded-full border border-[#f2c14e]/30 bg-[#0b1120]/90 py-2 pl-3 pr-4 shadow-xl backdrop-blur"
          >
            <span className="flex shrink-0 gap-1" aria-hidden="true">
              {TOUR.map((_, i) => (
                <span key={i} className={cn("size-1.5 rounded-full", i === beat ? "bg-[#f2c14e]" : i < beat ? "bg-[#f2c14e]/45" : "bg-white/20")} />
              ))}
            </span>
            <span className="min-w-0 text-xs text-[#e8f3f1]" aria-live="polite">
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
