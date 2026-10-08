"use client";

import { useState, type Dispatch } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus, Search } from "lucide-react";
import { APP_NAV_CORE, APP_NAV_EXTRAS, type AppNavItem } from "@/components/layout/app-nav";
import { cn } from "@/lib/utils";
import { useDemo } from "./demo-context";
import type { DemoAction, DemoState, Screen } from "./demo-state";
import { BTN_PRIMARY } from "./demo-ui";

/**
 * The sidebar of the real app (`components/layout/app-sidebar.tsx`), drawn from the app's own
 * nav definition (`app-nav.ts`) so a nav item added, renamed or reordered there shows up
 * here. It cannot be the real component — that one pulls in Clerk and the router — so the
 * classes are copied, and `scripts/smoke-waitlist-demo-fidelity.ts` keeps the rest honest.
 *
 * Only the four screens the preview has are live. The rest look like the real thing and do
 * nothing — except Events and Outreach, which really are coming soon (`comingSoon` in
 * `lib/surfaces.ts`, the "Soon" tag) and are also two of the page's poll options: a click
 * offers to jump to the poll and vote for them.
 */
const SCREEN_OF: Record<string, Exclude<Screen, "profile"> | undefined> = {
  "/dashboard": "dashboard",
  "/contacts": "contacts",
  "/chat": "chat",
  "/graph": "constellation",
};

/** Real nav items the preview leaves out, to keep the sidebar short. */
const HIDDEN = new Set(["/reminders", "/imports", "/knowledge", "/settings", "/radar", "/meetings"]);
const shown = (items: readonly AppNavItem[]) => items.filter((i) => !HIDDEN.has(i.href));

/** The items under the divider that really are coming soon, and the poll option each is. */
const SOON: Record<string, { label: string }> = {
  "/events": { label: "Events" },
  "/outreach": { label: "Outreach" },
};

const SPRING_PILL = { type: "spring", stiffness: 420, damping: 36 } as const;

export function DemoSidebar({ state, dispatch }: { state: DemoState; dispatch: Dispatch<DemoAction> }) {
  const { reduced } = useDemo();
  const active = state.screen === "profile" ? "contacts" : state.screen;
  const [soon, setSoon] = useState<string | null>(null);

  function goToPoll() {
    setSoon(null);
    document.getElementById("waitlist-poll")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }

  const item = (it: AppNavItem) => {
    const screen = SCREEN_OF[it.href];
    const isSoon = it.href in SOON;
    const on = screen !== undefined && active === screen;
    const Icon = it.icon;
    return (
      <li key={it.href} className="relative">
        <button
          type="button"
          data-demo-target={screen ? `nav-${screen}` : undefined}
          aria-current={on ? "page" : undefined}
          aria-disabled={screen || isSoon ? undefined : true}
          onClick={() => {
            if (screen) dispatch({ type: "go", screen });
            else if (isSoon) setSoon((cur) => (cur === it.href ? null : it.href));
          }}
          className={cn(
            "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
            on ? "text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {on && (
            <motion.span
              layoutId="demo-nav-pill"
              className="absolute inset-0 rounded-xl bg-white/10 ring-1 ring-white/10"
              transition={reduced ? { duration: 0 } : SPRING_PILL}
            />
          )}
          <Icon className="relative z-10 h-4 w-4 shrink-0" />
          <span className="relative z-10">{it.label}</span>
          {isSoon && (
            <span className="relative z-10 ml-auto rounded-full border border-warning/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-warning">
              Soon
            </span>
          )}
        </button>
        <AnimatePresence>
          {soon === it.href && (
            <motion.div
              initial={reduced ? false : { opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? undefined : { opacity: 0 }}
              transition={{ duration: 0.16 }}
              role="dialog"
              aria-label={`${SOON[it.href]!.label} is coming soon`}
              className="absolute left-[calc(100%+0.5rem)] top-0 z-40 w-56 rounded-xl border border-border bg-popover p-3 text-left shadow-xl"
            >
              <p className="text-sm font-medium text-ink">{SOON[it.href]!.label} is coming soon</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                It&apos;s one of the features you can vote for — spend a star on it.
              </p>
              <button type="button" onClick={goToPoll} className={cn(BTN_PRIMARY, "mt-2.5 h-7 w-full text-xs")}>
                Go to the poll
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </li>
    );
  };

  return (
    <aside className="h-full w-[15.5rem] shrink-0 p-3">
      <div className="liquid-glass flex h-full flex-col">
        <div className="flex items-center gap-2.5 px-4 py-4">
          {/* A plain img: the waitlist host serves /waitlist/ and nothing else, and next/image's optimizer would ask for more. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/waitlist/logo.png" alt="" width={32} height={32} className="size-8 rounded-full" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="font-[family-name:var(--font-display)] text-lg text-sidebar-primary">Orbit</p>
            <p className="text-[11px] text-muted-foreground">Network tracker</p>
          </div>
          <button
            type="button"
            aria-label="Search your network"
            onClick={() => dispatch({ type: "overlay", overlay: "palette" })}
            className="inline-flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground"
          >
            <Search className="size-3.5" />
          </button>
        </div>

        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => dispatch({ type: "overlay", overlay: "log", logFor: state.screen === "profile" ? state.profileId : null })}
            className={cn(BTN_PRIMARY, "h-9 w-full shadow-sm")}
          >
            <Plus className="size-4" aria-hidden="true" />
            Log interaction
          </button>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col overflow-hidden px-2" aria-label="Demo app">
          <ul className="space-y-0.5">{shown(APP_NAV_CORE).map(item)}</ul>
          <div className="my-2 flex items-center gap-2 px-3" aria-hidden="true">
            <span className="h-px flex-1 bg-white/10" />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Coming soon</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <ul className="space-y-0.5">{shown(APP_NAV_EXTRAS).map(item)}</ul>
        </nav>

        <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-tier-lifetime/20 text-[11px] font-medium text-tier-lifetime">
            You
          </span>
          <span className="text-xs text-muted-foreground">Account</span>
        </div>
      </div>
    </aside>
  );
}
