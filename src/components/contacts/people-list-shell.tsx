"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, ViewTransition } from "react";
import { motion } from "motion/react";
import { IntentLink } from "@/components/ui/intent-link";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  clearPeopleNavInBrowser,
  directionForPeopleNav,
  isPeopleNavInBrowser,
  markPeopleNavInBrowser,
} from "@/lib/people-nav";

const OPTIONS = [
  { key: "contacts" as const, href: "/contacts", label: "Contacts" },
  { key: "recruiters" as const, href: "/recruiters", label: "Recruiters" },
];

function PeopleViewToggle({
  visual,
  onNavigate,
}: {
  visual: "contacts" | "recruiters";
  onNavigate: (key: "contacts" | "recruiters", href: string) => void;
}) {
  return (
    <div
      className="relative flex w-[11.5rem] shrink-0 rounded-lg border border-border/70 bg-card p-0.5 text-sm"
      role="tablist"
      aria-label="People view"
    >
      {OPTIONS.map((opt) => {
        const selected = visual === opt.key;
        return (
          <IntentLink
            key={opt.key}
            href={opt.href}
            role="tab"
            aria-selected={selected}
            onClick={(e) => {
              e.preventDefault();
              if (opt.key === visual) return;
              onNavigate(opt.key, opt.href);
            }}
            className={cn(
              "relative z-10 flex-1 rounded-md px-2 py-1.5 text-center transition-colors",
              selected
                ? "text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {selected && (
              <motion.span
                layoutId="people-view-pill"
                className="absolute inset-0 -z-10 rounded-md bg-primary shadow-sm"
                transition={SPRING_PILL}
              />
            )}
            <span className="relative">{opt.label}</span>
          </IntentLink>
        );
      })}
    </div>
  );
}

export function PeopleListShell({
  active,
  title,
  subtitle,
  actions,
  pending = false,
  children,
}: {
  active: "contacts" | "recruiters";
  title: string;
  subtitle: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Set by the route's loading fallback. It draws this same header while the other view's
   * data loads, so it must leave the in-flight marker for the real page to read.
   */
  pending?: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [visual, setVisual] = useState(active);
  // Switching views swaps this shell for an identical one (fallback, then page). Fading the
  // title in each time reads as a blink, so a switch in flight draws it already in place.
  const [settled] = useState(() => isPeopleNavInBrowser());

  useEffect(() => {
    router.prefetch("/contacts");
    router.prefetch("/recruiters");
  }, [router]);

  useEffect(() => {
    setVisual(active);
    if (!pending) clearPeopleNavInBrowser();
  }, [active, pending]);

  function navigateTo(key: "contacts" | "recruiters", href: string) {
    if (key === active) return;
    const dir = directionForPeopleNav(active, key);
    // Cookie lets the route's loading.tsx skip its skeleton mid-toggle.
    markPeopleNavInBrowser();
    setVisual(key);
    // Navigate immediately — the View Transition snapshots the outgoing
    // list, so no artificial exit delay is needed.
    startTransition(() => {
      router.push(href, {
        transitionTypes: [dir > 0 ? "people-fwd" : "people-back"],
      });
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/*
          The title and the toggle share a row of their own, and nothing else does. The
          actions used to sit in this row too, so the toggle's place depended on how many
          buttons the page had: Contacts and Recruiters wrapped differently, and the toggle
          moved when you switched. Now the only thing that decides where it sits is the title
          block's floor, which is the same on both pages.

          A floor on the title block, not `min-w-0`. With a zero minimum the row never
          wraps: the title just gives up width to the toggle and a long subtitle breaks into a
          sliver. With a 16rem floor, flex-wrap sends the toggle to its own line before the
          title gives anything up.
        */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-64 flex-1">
            <motion.h1
              key={title}
              initial={settled ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
              className="font-[family-name:var(--font-display)] text-3xl text-ink"
            >
              {title}
            </motion.h1>
            <motion.p
              key={String(subtitle)}
              initial={settled ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: DUR.base, delay: 0.04, ease: EASE_HOUSE }}
              className="mt-1 text-muted-foreground"
            >
              {subtitle}
            </motion.p>
          </div>
          {/*
            One shared element across the page swap. Each view is its own route, so the toggle
            is unmounted with one page and mounted with the next; naming it lets the browser
            treat the two as the same thing and hold it still, instead of the old copy
            leaving and the new one arriving.
          */}
          <ViewTransition name="people-view-toggle" enter="none" exit="none" update="none" share="auto">
            <PeopleViewToggle visual={visual} onNavigate={navigateTo} />
          </ViewTransition>
        </div>
        {/* Reserved while the page loads, so the actions arriving don't push the list down. */}
        {actions || pending ? (
          <div className="flex min-h-10 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      <ViewTransition
        enter={{
          "people-fwd": "people-fwd",
          "people-back": "people-back",
          default: "none",
        }}
        exit={{
          "people-fwd": "people-fwd",
          "people-back": "people-back",
          default: "none",
        }}
        default="none"
      >
        <div className="w-full">{children}</div>
      </ViewTransition>
    </div>
  );
}
