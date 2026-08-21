"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, ViewTransition } from "react";
import { motion } from "motion/react";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { FeatureLock } from "@/components/plan/plan-logo";
import { TooltipProvider } from "@/components/ui/tooltip";
import { includedInLabel } from "@/lib/plan-limits";
import {
  clearPeopleNavInBrowser,
  directionForPeopleNav,
  markPeopleNavInBrowser,
} from "@/lib/people-nav";

const OPTIONS = [
  { key: "contacts" as const, href: "/contacts", label: "Contacts" },
  { key: "recruiters" as const, href: "/recruiters", label: "Recruiters" },
];

function PeopleViewToggle({
  visual,
  onNavigate,
  recruitersLocked,
}: {
  visual: "contacts" | "recruiters";
  onNavigate: (key: "contacts" | "recruiters", href: string) => void;
  recruitersLocked: boolean;
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
            {opt.key === "recruiters" && recruitersLocked ? (
              <FeatureLock
                includedIn={includedInLabel("recruiters")}
                label="Recruiter tracking"
                className="w-full justify-center"
              >
                <span className="relative w-full text-center">{opt.label}</span>
              </FeatureLock>
            ) : (
              <span className="relative">{opt.label}</span>
            )}
          </Link>
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
  children,
  recruitersLocked = false,
}: {
  active: "contacts" | "recruiters";
  title: string;
  subtitle: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Recruiter tracking is a paid feature; the tab still navigates to its explainer. */
  recruitersLocked?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [visual, setVisual] = useState(active);

  useEffect(() => {
    router.prefetch("/contacts");
    router.prefetch("/recruiters");
  }, [router]);

  useEffect(() => {
    setVisual(active);
    clearPeopleNavInBrowser();
  }, [active]);

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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <motion.h1
            key={title}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DUR.base, ease: EASE_HOUSE }}
            className="font-[family-name:var(--font-display)] text-3xl text-primary"
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
          <TooltipProvider>
            <PeopleViewToggle
              visual={visual}
              onNavigate={navigateTo}
              recruitersLocked={recruitersLocked}
            />
          </TooltipProvider>
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
