"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "motion/react";
import { cn } from "@/lib/utils";
import {
  clearPeopleNavInBrowser,
  directionForPeopleNav,
  markPeopleNavInBrowser,
  setPeopleNavDirection,
  takePeopleNavDirection,
} from "@/lib/people-nav";

const OPTIONS = [
  { key: "contacts" as const, href: "/contacts", label: "Contacts" },
  { key: "recruiters" as const, href: "/recruiters", label: "Recruiters" },
];

const EASE = [0.22, 1, 0.36, 1] as const;
const EXIT_MS = 220;

function PeopleViewToggle({
  visual,
  onNavigate,
  disabled,
}: {
  visual: "contacts" | "recruiters";
  onNavigate: (key: "contacts" | "recruiters", href: string) => void;
  disabled?: boolean;
}) {
  const reducedMotion = useReducedMotion();

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
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : undefined}
            onClick={(e) => {
              e.preventDefault();
              if (disabled || opt.key === visual) return;
              onNavigate(opt.key, opt.href);
            }}
            className={cn(
              "relative z-10 flex-1 rounded-md px-2 py-1.5 text-center transition-colors",
              selected
                ? "text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
              disabled && "pointer-events-none opacity-70"
            )}
          >
            {selected && (
              <motion.span
                layoutId={reducedMotion ? undefined : "people-view-pill"}
                className="absolute inset-0 -z-10 rounded-md bg-primary shadow-sm"
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 480, damping: 36 }
                }
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
  title,
  subtitle,
  actions,
  children,
}: {
  active: "contacts" | "recruiters";
  title: string;
  subtitle: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [, startTransition] = useTransition();
  const [visual, setVisual] = useState(active);
  const [direction] = useState(() => takePeopleNavDirection());
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    router.prefetch("/contacts");
    router.prefetch("/recruiters");
  }, [router]);

  useEffect(() => {
    setVisual(active);
    setLeaving(false);
    clearPeopleNavInBrowser();
  }, [active]);

  function navigateTo(key: "contacts" | "recruiters", href: string) {
    if (key === active || leaving) return;
    const dir = directionForPeopleNav(active, key);
    setPeopleNavDirection(dir);
    markPeopleNavInBrowser();
    setVisual(key);
    setLeaving(true);

    const go = () => {
      startTransition(() => {
        router.push(href);
      });
    };

    if (reducedMotion) {
      go();
      return;
    }

    window.setTimeout(go, EXIT_MS);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <motion.h1
            key={title}
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.25, ease: EASE }}
            className="font-[family-name:var(--font-display)] text-3xl text-primary"
          >
            {title}
          </motion.h1>
          <motion.p
            key={String(subtitle)}
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
              duration: reducedMotion ? 0 : 0.25,
              delay: reducedMotion ? 0 : 0.04,
              ease: EASE,
            }}
            className="mt-1 text-muted-foreground"
          >
            {subtitle}
          </motion.p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
          {/* Always rightmost so it stays in the same screen position on both pages */}
          <PeopleViewToggle
            visual={visual}
            onNavigate={navigateTo}
            disabled={leaving}
          />
        </div>
      </div>

      <div className="relative overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {!leaving && (
            <motion.div
              key={active}
              initial={
                reducedMotion
                  ? false
                  : {
                      x: direction === 0 ? 0 : direction > 0 ? 36 : -36,
                      opacity: 0,
                    }
              }
              animate={{ x: 0, opacity: 1 }}
              exit={
                reducedMotion
                  ? { opacity: 0 }
                  : {
                      x: visual === "recruiters" ? -32 : 32,
                      opacity: 0,
                    }
              }
              transition={{
                duration: reducedMotion ? 0 : EXIT_MS / 1000,
                ease: EASE,
              }}
              className="w-full will-change-transform"
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
