"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { castPollVote } from "@/actions/waitlist-poll";
import { EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { pulseStarfield } from "@/lib/starfield-events";
import { cn } from "@/lib/utils";
import { onPass } from "@/lib/waitlist-pass-events";
import {
  POLL_ERROR,
  POLL_OPTIONS,
  POLL_RESULTS_CAPTION,
  applyVote,
  rankPoll,
  type PollOptionId,
  type PollResults,
} from "@/lib/waitlist-poll";

export type FeaturePollInitial = { results: PollResults; choice: PollOptionId | null };

/**
 * The waitlist's feature poll. Before a vote: toggle-button cards in authored order, no results.
 * One tap votes (no submit button); the bars then grow in and the cards glide into ranked
 * order, the pick highlighted. Tapping another card moves the vote.
 *
 * Each card is a `<button aria-pressed>` in a labelled group: Tab walks the cards in their
 * current visual order, Enter/Space votes, and moving focus never does (native radios would
 * select on arrow keys, which fights the list reordering after a vote). The vote is applied
 * optimistically and replaced by the server's tally; a failure rolls it back and says so.
 *
 * A visitor who already voted gets the ranked view from the server on first paint, and their
 * bars start at full length (`initial={false}`) rather than replaying the reveal.
 *
 * `me` is the visitor's `?me=` pass token, if any, so the server can tie the vote to their
 * signup. A visitor who joins on this page gets their token from the hero via `onPass`
 * (`replaceState` does not re-render the server-fed `me`). Reduced motion is read at render
 * time from `useReducedMotion`, not from a post-mount effect: a hook that flips after mount
 * would let the first transition play.
 */
export function FeaturePoll({ initial, me }: { initial: FeaturePollInitial; me: string | null }) {
  const reduced = useReducedMotion();
  const [results, setResults] = useState(initial.results);
  const [choice, setChoice] = useState(initial.choice);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [, startTransition] = useTransition();
  const [votedOnLoad] = useState(initial.choice !== null);
  const inFlight = useRef(false);
  const [passToken, setPassToken] = useState<string | null>(null);

  useEffect(() => onPass(setPassToken), []);

  const voted = choice !== null;
  const view = rankPoll(results);
  const byId = new Map(view.options.map((o) => [o.id, o]));
  const ordered = voted ? view.options : POLL_OPTIONS.map((o) => byId.get(o.id)!);

  function vote(id: PollOptionId, source: HTMLElement) {
    if (inFlight.current || id === choice) return;
    inFlight.current = true;
    const before = { results, choice };
    setError(null);
    setResults(applyVote(results, choice, id));
    setChoice(id);

    const rect = source.getBoundingClientRect();
    pulseStarfield(rect.left + rect.width / 2, rect.top + rect.height / 2);

    const rollback = (message: string) => {
      setResults(before.results);
      setChoice(before.choice);
      setError(message);
    };
    startTransition(async () => {
      try {
        const res = await castPollVote({ optionId: id, me: passToken ?? me });
        if (!res.ok) {
          rollback(res.message);
          return;
        }
        setResults(res.results);
        setChoice(res.choice);
        const label = POLL_OPTIONS.find((o) => o.id === res.choice)?.label ?? "";
        setAnnouncement(`Your vote for “${label}” is in.`);
      } catch (err) {
        console.error("[feature-poll] vote failed", err);
        rollback(POLL_ERROR);
      } finally {
        inFlight.current = false;
      }
    });
  }

  const glide = reduced ? { duration: 0 } : SPRING_SOFT;
  const grow = reduced ? { duration: 0 } : { duration: 0.7, ease: EASE_HOUSE };

  return (
    // The panel: the same glass as the steps and FAQ cards, but less transparent
    // (`feature-poll-panel`, globals.css) so six rows of copy hold up against the starfield,
    // plus a faint gold bloom from the top edge so the poll reads as one object.
    // `overflow-hidden` clips the bloom to the rounded corners; the cards inside stay
    // `overflow-hidden` themselves.
    <div className="landing-glass feature-poll-panel relative mx-auto w-full max-w-2xl overflow-hidden rounded-3xl p-4 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(ellipse_at_top,rgba(242,193,78,0.10),transparent_70%)]"
      />
      <div role="group" aria-label="Which feature do you want most?" className="relative">
        <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">Feature poll</p>
        <ul className="mt-4 grid gap-3">
          {ordered.map((opt) => {
            const selected = choice === opt.id;
            return (
              <motion.li key={opt.id} layout="position" transition={glide}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={(e) => vote(opt.id, e.currentTarget)}
                  className={cn(
                    "landing-glass relative block w-full cursor-pointer overflow-hidden rounded-2xl border border-transparent px-5 py-4 text-left transition-all duration-150",
                    "hover:border-[#e8f3f1]/20 hover:bg-[#e8f3f1]/[0.05] motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60",
                    selected && "border-[#f2c14e]/50"
                  )}
                >
                  {voted && (
                    <motion.span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-full origin-left bg-[#f2c14e]/[0.13]"
                      initial={votedOnLoad ? false : { scaleX: 0 }}
                      animate={{ scaleX: opt.count === 0 ? 0 : Math.max(opt.bar, 0.06) }}
                      transition={grow}
                    />
                  )}
                  <span className="relative flex items-center gap-3">
                    {voted && (
                      <span aria-hidden="true" className="w-5 shrink-0 text-sm tabular-nums text-[#6d807c]">{opt.rank}</span>
                    )}
                    <span className="flex-1 text-sm font-medium text-[#e8f3f1] sm:text-base">{opt.label}</span>
                    {selected && <Check className="size-4 shrink-0 text-[#f2c14e]" aria-hidden="true" />}
                    {voted && view.showNumbers && (
                      <span className="w-11 shrink-0 text-right text-sm tabular-nums text-[#9aada8]">
                        {opt.share}%
                      </span>
                    )}
                  </span>
                </button>
              </motion.li>
            );
          })}
        </ul>
      </div>

      <p className="mt-4 text-center text-sm text-[#9aada8]">
        {!voted
          ? "Pick the one you'd use most, then see how everyone voted."
          : view.showNumbers
            ? `${view.total.toLocaleString("en-US")} votes so far. Tap another to change yours.`
            : POLL_RESULTS_CAPTION}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-center text-sm text-[#f0a3a3]">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
