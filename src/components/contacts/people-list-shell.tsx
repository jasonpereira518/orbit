"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, ViewTransition } from "react";
import { motion } from "motion/react";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  clearPeopleNavInBrowser,
  directionForPeopleNav,
  markPeopleNavInBrowser,
  type PeopleView,
} from "@/lib/people-nav";

const OPTIONS: Array<{ key: PeopleView; href: string; label: string }> = [
  { key: "contacts", href: "/contacts", label: "Contacts" },
  { key: "work", href: "/contacts?view=work", label: "Work" },
  { key: "recruiters", href: "/recruiters", label: "Recruiters" },
];

function PeopleViewToggle({
  visual,
  showWork,
  onNavigate,
}: {
  visual: PeopleView;
  showWork: boolean;
  onNavigate: (key: PeopleView, href: string) => void;
}) {
  const options = OPTIONS.filter((o) => showWork || o.key !== "work");
  return (
    <div
      className={cn(
        "relative flex shrink-0 rounded-lg border border-border/70 bg-card p-0.5 text-sm",
        showWork ? "w-[16.5rem]" : "w-[11.5rem]"
      )}
      role="tablist"
      aria-label="People view"
    >
      {options.map((opt) => {
        const selected = visual === opt.key;
        return (
          <Link
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
          </Link>
        );
      })}
    </div>
  );
}

export function PeopleListShell({
  active,
  showWork = false,
  title,
  subtitle,
  actions,
  children,
}: {
  active: PeopleView;
  showWork?: boolean;
  title: string;
  subtitle: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [visual, setVisual] = useState(active);

  useEffect(() => {
    router.prefetch("/contacts");
    if (showWork) router.prefetch("/contacts?view=work");
    router.prefetch("/recruiters");
  }, [router, showWork]);

  useEffect(() => {
    setVisual(active);
    clearPeopleNavInBrowser();
  }, [active]);

  function navigateTo(key: PeopleView, href: string) {
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        {/*
          A floor on the title block, not `min-w-0`. With a zero minimum the row never
          wraps: the title just gives up width to the actions, and at tablet widths it
          was squeezed to ~150px — "800 people in your network" broke across two lines
          beside a row of buttons that had room to move. With a 16rem floor, flex-wrap
          sends the actions to their own line before the title gives anything up.
        */}
        <div className="min-w-64 flex-1">
          <motion.h1
            key={title}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DUR.base, ease: EASE_HOUSE }}
            className="font-[family-name:var(--font-display)] text-3xl text-ink"
          >
            {title}
          </motion.h1>
          <motion.p
            key={String(subtitle)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: DUR.base, delay: 0.04, ease: EASE_HOUSE }}
            className="mt-1 text-muted-foreground"
          >
            {subtitle}
          </motion.p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
          {/* Always rightmost so it stays in the same screen position on both pages */}
          <PeopleViewToggle visual={visual} showWork={showWork} onNavigate={navigateTo} />
        </div>
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
