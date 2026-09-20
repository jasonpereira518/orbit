"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import type { ChatStep } from "@/lib/chat-stream-protocol";

/**
 * What the answer actually did, while it does it.
 *
 * The chat used to show one hardcoded "Searching your network…" for the whole five to nine
 * seconds of query understanding, hybrid search, reranking and generation. This narrates
 * the real stages instead: every line here was written by the server from a stage that ran,
 * so the counts, durations and names are facts rather than a scripted sequence. A stage
 * that was skipped sends nothing, and this renders nothing for it.
 *
 * Live it is one line that replaces itself; finished it collapses to a summary you can open
 * to see each stage, how long it took, and the records it read.
 */

export type ChatActivityProps = {
  steps: ChatStep[];
  /** `live` while the answer is still streaming; `final` once it has landed. */
  state: "live" | "final";
  /** `compact` is the ask bar: one line, no expansion. */
  variant?: "full" | "compact";
  className?: string;
};

export function ChatActivity({ steps, state, variant = "full", className }: ChatActivityProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  const active = useMemo(
    () => [...steps].reverse().find((step) => step.status === "active") ?? null,
    [steps]
  );
  const summary = useMemo(() => summarise(steps), [steps]);

  if (steps.length === 0) return null;

  if (state === "live") {
    const label = active?.label ?? "Working on it";
    return (
      <div
        className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}
        aria-live="polite"
        aria-atomic="true"
      >
        <OrbitMark reduceMotion={reduceMotion} />
        {/*
          Keyed on the label so each new stage cross-fades in place rather than the text
          swapping instantly. `mode="wait"` would leave a gap with nothing in it, which
          reads as a stall on the very thing meant to show progress.
        */}
        <span className="relative min-w-0">
          <AnimatePresence initial={false}>
            <motion.span
              key={label}
              className="block truncate"
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, position: "absolute" }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
            >
              {label}
              {active?.detail ? (
                <span className="text-muted-foreground/70"> · {active.detail}</span>
              ) : null}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>{summary}</p>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.ol
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2 border-l border-border/70 pl-3">
              {steps.map((step) => (
                <li key={step.id} className="text-xs text-muted-foreground">
                  <span className="text-foreground/80">{step.label}</span>
                  {typeof step.ms === "number" && (
                    <span className="text-muted-foreground/70"> · {formatMs(step.ms)}</span>
                  )}
                  {step.detail && (
                    <span className="block text-muted-foreground/70">{step.detail}</span>
                  )}
                  {step.refs && step.refs.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {step.refs.map((ref) =>
                        ref.kind === "contact" ? (
                          <Link
                            key={`${step.id}-${ref.id}`}
                            href={`/contacts/${ref.id}`}
                            className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                          >
                            {ref.name}
                          </Link>
                        ) : (
                          <span
                            key={`${step.id}-${ref.id}`}
                            className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-foreground/80"
                          >
                            {ref.name}
                          </span>
                        )
                      )}
                    </span>
                  )}
                </li>
              ))}
            </div>
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The one brand touch: a dot on an orbit, rather than a generic spinner.
 *
 * Reduced motion gets a static ring instead of stopping at a random frame — the decision is
 * made at render time because `usePrefersReducedMotion` reports false on its first render,
 * and an effect that hid this and bailed would strand the indicator entirely.
 */
function OrbitMark({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="absolute inset-0 rounded-full border border-primary/30" />
      {reduceMotion ? (
        <span className="absolute right-0 top-1/2 size-1 -translate-y-1/2 rounded-full bg-primary" />
      ) : (
        <motion.span
          className="absolute inset-0"
          animate={{ rotate: 360 }}
          transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
        >
          <span className="absolute right-0 top-1/2 size-1 -translate-y-1/2 rounded-full bg-primary" />
        </motion.span>
      )}
    </span>
  );
}

/** "Looked at 9 contacts · 4.2s" — built only from steps that reported real numbers. */
function summarise(steps: ChatStep[]): string {
  const people = new Set<string>();
  for (const step of steps) {
    for (const ref of step.refs ?? []) {
      if (ref.kind === "contact") people.add(ref.id);
    }
  }
  const total = steps.reduce((sum, step) => sum + (step.ms ?? 0), 0);

  const parts: string[] = [];
  if (people.size > 0) {
    parts.push(`Looked at ${people.size} ${people.size === 1 ? "contact" : "contacts"}`);
  } else {
    parts.push(`${steps.length} ${steps.length === 1 ? "step" : "steps"}`);
  }
  if (total > 0) parts.push(formatMs(total));
  return parts.join(" · ");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
