"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, CircleDashed } from "lucide-react";
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
 * Live, it is a card: the stage running now as its header, the stages already finished
 * ticked off beneath it. Finished, it collapses to a one-line summary you can open again.
 * The ask bar (`compact`) has no room for either, so it gets a single line.
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
  // Two separate flags: whether the live card is folded and whether the finished summary is
  // open are different questions, and sharing one would make the summary spring open (or
  // shut) the instant the answer lands.
  const [liveOpen, setLiveOpen] = useState(true);
  const [finalOpen, setFinalOpen] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  /**
   * What the header says right now.
   *
   * The most recently started stage that is still running — and when nothing is running,
   * the last stage that did, rather than a generic "working on it". The stages fan out in
   * parallel, so there are real gaps between one finishing and the next starting; filling
   * them with the last true statement keeps the line honest without inventing a stage.
   */
  const current = useMemo(() => {
    const running = [...steps].reverse().find((step) => step.status === "active");
    return running ?? steps[steps.length - 1] ?? null;
  }, [steps]);
  const finished = useMemo(
    () => steps.filter((step) => step.status === "done" && step.id !== current?.id),
    [steps, current]
  );
  const summary = useMemo(() => summarise(steps), [steps]);

  if (steps.length === 0) return null;

  if (state === "live") {
    const label = current?.label ?? "Starting";

    const header = (
      <>
        <OrbitMark reduceMotion={reduceMotion} />
        {/*
          `mode="wait"` is load-bearing, not a preference. Overlapping enter/exit left the
          outgoing label mounted, so the line accumulated every stage it had ever shown —
          and because this is an aria-live region, a screen reader read the whole history
          aloud on each change. Waiting for the exit guarantees exactly one label.
        */}
        <span className="min-w-0 flex-1 text-left" aria-live="polite" aria-atomic="true">
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              key={label}
              className="block truncate"
              initial={reduceMotion ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
              transition={{ duration: DUR.fast, ease: EASE_HOUSE }}
            >
              {label}
              {current?.detail ? (
                <span className="text-muted-foreground/70"> · {current.detail}</span>
              ) : null}
            </motion.span>
          </AnimatePresence>
        </span>
      </>
    );

    if (variant === "compact") {
      return (
        <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
          {header}
        </div>
      );
    }

    const canFold = finished.length > 0;
    return (
      <div className={cn("rounded-xl border border-primary/30 bg-muted/30", className)}>
        <button
          type="button"
          onClick={() => canFold && setLiveOpen((v) => !v)}
          aria-expanded={canFold ? liveOpen : undefined}
          disabled={!canFold}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-foreground disabled:cursor-default"
        >
          {header}
          {canFold && (
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                liveOpen && "rotate-180"
              )}
              aria-hidden="true"
            />
          )}
        </button>

        <AnimatePresence initial={false}>
          {liveOpen && finished.length > 0 && (
            <motion.div
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
              className="overflow-hidden"
            >
              <ul className="space-y-1.5 px-3 pb-3 pl-[2.1rem]">
                {finished.map((step) => (
                  <li
                    key={step.id}
                    className="relative text-xs leading-snug text-muted-foreground"
                  >
                    <Check
                      className="absolute -left-[1.15rem] top-px size-3.5 text-primary"
                      aria-hidden="true"
                    />
                    <span className="text-foreground/80">{step.label}</span>
                    {step.detail && <span> · {step.detail}</span>}
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  if (variant === "compact") {
    return <p className={cn("text-xs text-muted-foreground", className)}>{summary}</p>;
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setFinalOpen((v) => !v)}
        aria-expanded={finalOpen}
        className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <CircleDashed className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{summary}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", finalOpen && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {finalOpen && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
            className="overflow-hidden"
          >
            <ol className="mt-2 space-y-2 border-l border-border/70 pl-3">
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
            </ol>
          </motion.div>
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
