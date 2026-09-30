"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ComponentType } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bell, Calendar, MessageSquare, Network, Plug, Send, Star } from "lucide-react";
import { setPollStars } from "@/actions/waitlist-poll";
import { usePassProgress, type PassProgress } from "@/lib/interest-progress-store";
import { EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { pulseStarfield } from "@/lib/starfield-events";
import { cn } from "@/lib/utils";
import { onPass } from "@/lib/waitlist-pass-events";
import {
  BASE_STARS,
  POLL_ERROR,
  POLL_OPTIONS,
  POLL_RESULTS_CAPTION,
  allocationTotal,
  applyAllocation,
  rankPoll,
  starBudget,
  type PollOptionId,
  type PollResults,
  type StarAllocation,
} from "@/lib/waitlist-poll";

export type FeaturePollInitial = { results: PollResults; allocation: StarAllocation; budget: number };

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** One icon per option — same family the waitlist demo nav uses. */
const POLL_ICONS: Record<PollOptionId, IconType> = {
  "constellation-map": Network,
  "network-chat": MessageSquare,
  "outreach-campaign": Send,
  events: Calendar,
  "auto-integrations": Plug,
  "smart-follow-ups": Bell,
};

const STAR_LEFT = (n: number) => (n === 1 ? "1 star" : `${n} stars`);

function sameAllocation(a: StarAllocation, b: StarAllocation) {
  return POLL_OPTIONS.every((o) => (a[o.id] ?? 0) === (b[o.id] ?? 0));
}

/** True once `ref`'s element is within 600px of the screen, and stays true. */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

/**
 * The waitlist's feature poll: everyone spends STARS — three, plus one for every friend who
 * joined through their link — on the features they want first, stacked or spread.
 *
 * One ranked list on every screen: an icon, the feature and what it is, its share of the vote
 * as a bar behind the row, and your own stars. Tap a row to place a star on it; tap one of its stars to take it back. The list re-sorts as the tally moves.
 *
 * STATE. `server` is the last tally and allocation the server confirmed; `mine` is what the
 * visitor has now. The tally on screen is `server.results` with `mine` swapped in for
 * `server.mine`, so a tap moves the bars at once, and a live refresh of the tally never
 * clobbers stars that have not been saved yet. Every write sends the WHOLE allocation, one at
 * a time (a tap during a save queues the latest state), and the server's answer replaces the
 * guess; a failure rolls `mine` back and says so.
 *
 * LIVE. While the tab is visible and the poll is near the screen, the tally is re-read every
 * 30 seconds, so the race moves while you watch. Reads that land right after your own save are
 * ignored: another server instance may still hold a tally from before it.
 *
 * The budget grows live from the pass's referral count (`usePassProgress`); the server
 * re-counts the friends itself on every write, so the client cannot spend stars it has not
 * earned. `me` is the visitor's `?me=` pass token, if any; a visitor who joins on this page
 * gets theirs from the hero via `onPass`. Reduced motion is read at render time from
 * `useReducedMotion`: rows jump to their places.
 */
export function FeaturePoll({ initial, me }: { initial: FeaturePollInitial; me: string | null }) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const near = useNear(rootRef);

  const [server, setServer] = useState({ results: initial.results, mine: initial.allocation });
  const [mine, setMineState] = useState<StarAllocation>(initial.allocation);
  const mineRef = useRef(mine);
  const serverRef = useRef(server);
  const [serverBudget, setServerBudget] = useState(initial.budget);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [, startTransition] = useTransition();
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const holdPollUntil = useRef(0);
  const [passToken, setPassToken] = useState<string | null>(null);

  useEffect(() => onPass(setPassToken), []);

  const setMine = useCallback((next: StarAllocation) => {
    mineRef.current = next;
    setMineState(next);
  }, []);
  const setServerBoth = useCallback((next: { results: PollResults; mine: StarAllocation }) => {
    serverRef.current = next;
    setServer(next);
  }, []);

  // The budget: the server's last word, or the friends the pass already shows, whichever is more.
  const initialProgress = useMemo<PassProgress>(
    () => ({ token: me, referrals: Math.max(0, initial.budget - BASE_STARS), position: null }),
    [me, initial.budget]
  );
  const progress = usePassProgress(initialProgress);
  const budget = Math.max(serverBudget, progress.token ? starBudget(progress.referrals) : 0);
  const spent = allocationTotal(mine);
  const left = Math.max(0, budget - spent);

  // "+1 star" the moment a friend joins while the page is open.
  const prevBudget = useRef(budget);
  useEffect(() => {
    const before = prevBudget.current;
    prevBudget.current = budget;
    if (budget <= before) return;
    const text = budget - before === 1 ? "+1 star — a friend joined." : `+${budget - before} stars — friends joined.`;
    setNote(text);
    setAnnouncement(`${text} You have ${STAR_LEFT(budget - allocationTotal(mineRef.current))} left.`);
    const t = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [budget]);

  const tally = useMemo(() => applyAllocation(server.results, server.mine, mine), [server, mine]);
  const view = rankPoll(tally);
  const byId = new Map(view.options.map((o) => [o.id, o]));
  const hasStars = view.total > 0;

  const flush = useCallback(() => {
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    dirty.current = false;
    const sent = mineRef.current;
    let failed = false;
    startTransition(async () => {
      try {
        const res = await setPollStars({ allocation: sent, me: passToken ?? me });
        if (!res.ok) {
          failed = true;
          setMine(serverRef.current.mine);
          setError(res.message);
          return;
        }
        setServerBoth({ results: res.results, mine: res.allocation });
        setServerBudget(res.budget);
        holdPollUntil.current = Date.now() + 31_000;
        setAnnouncement(`Saved. You have ${STAR_LEFT(Math.max(0, res.budget - allocationTotal(mineRef.current)))} left.`);
      } catch (err) {
        console.error("[feature-poll] save failed", err);
        failed = true;
        setMine(serverRef.current.mine);
        setError(POLL_ERROR);
      } finally {
        inFlight.current = false;
        if (failed) dirty.current = false;
        else if (dirty.current && !sameAllocation(mineRef.current, sent)) flush();
      }
    });
  }, [me, passToken, setMine, setServerBoth]);

  function change(id: PollOptionId, delta: 1 | -1, source?: HTMLElement) {
    const have = mineRef.current[id] ?? 0;
    if (delta > 0 && allocationTotal(mineRef.current) >= budget) {
      setError("No stars left — take one back first.");
      return;
    }
    if (delta < 0 && have === 0) return;
    setError(null);
    const next = { ...mineRef.current };
    const n = have + delta;
    if (n > 0) next[id] = n;
    else delete next[id];
    setMine(next);
    if (delta > 0 && source) {
      const r = source.getBoundingClientRect();
      pulseStarfield(r.left + r.width / 2, r.top + r.height / 2);
    }
    flush();
  }

  // Live results: every 30 s while the tab is visible and the poll is near the screen.
  useEffect(() => {
    if (!near) return;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight.current || Date.now() < holdPollUntil.current) return;
      try {
        const res = await fetch("/api/waitlist-poll/results", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; counts?: Record<string, number>; voters?: number };
        if (!data.ok || !data.counts || typeof data.voters !== "number") return;
        if (inFlight.current || Date.now() < holdPollUntil.current) return;
        setServerBoth({ results: { counts: data.counts, voters: data.voters }, mine: serverRef.current.mine });
      } catch {
        // Offline: the next tick tries again.
      }
    };
    const id = window.setInterval(() => void tick(), 30_000);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [near, setServerBoth]);

  const glide = reduced ? { duration: 0 } : SPRING_SOFT;

  /** The row's stars: each one you have placed is a button that takes it back; the rest are empty slots. */
  const stars = (id: PollOptionId, label: string) => {
    const n = mine[id] ?? 0;
    return (
      <div className="pointer-events-auto relative z-10 flex shrink-0 items-center">
        {Array.from({ length: Math.max(BASE_STARS, n) }, (_, i) =>
          i < n ? (
            <button
              key={i}
              type="button"
              aria-label={`Take a star back from ${label}`}
              onClick={() => change(id, -1)}
              className="group flex size-8 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60"
            >
              <Star className="size-5 fill-[#f2c14e] text-[#f2c14e] transition-transform group-hover:scale-90 group-hover:opacity-60" aria-hidden={true} />
            </button>
          ) : (
            <span key={i} className="flex size-8 items-center justify-center" aria-hidden={true}>
              <Star className="size-5 text-[#e8f3f1]/20" />
            </span>
          )
        )}
      </div>
    );
  };

  return (
    // Same deep-navy panel as the referral tracker (`.feature-poll-panel` / shared interest panel).
    <div ref={rootRef} className="landing-glass feature-poll-panel mx-auto w-full max-w-2xl rounded-3xl p-4 sm:p-6">
      <div role="group" aria-label="Which features do you want first? Spend your stars.">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm text-[#e8f3f1]">
            <span className="mr-1.5 inline-flex gap-0.5 align-[-2px]" aria-hidden={true}>
              {Array.from({ length: Math.min(budget, 8) }, (_, i) => (
                <Star key={i} className={cn("size-3.5", i < left ? "fill-[#f2c14e] text-[#f2c14e]" : "text-[#e8f3f1]/25")} />
              ))}
            </span>
            You have {STAR_LEFT(left)} left
            {budget > left ? <span className="text-[#9aada8]"> of {budget}</span> : null}
          </p>
          <p className="text-xs text-[#9aada8]">
            {note ? <span className="text-[#f2c14e]">{note}</span> : "Each friend who joins through your link adds one."}
          </p>
        </div>

        <ul className="mt-5 grid gap-2.5">
          {(hasStars ? view.options : POLL_OPTIONS.map((o) => byId.get(o.id)!)).map((v) => {
            const Icon = POLL_ICONS[v.id];
            const mineN = mine[v.id] ?? 0;
            return (
              <motion.li
                key={v.id}
                layout="position"
                transition={glide}
                className={cn(
                  "relative min-w-0 overflow-hidden rounded-2xl border px-4 py-3 transition-colors hover:border-[#f2c14e]/40",
                  mineN ? "border-[#f2c14e]/40 bg-[#f2c14e]/[0.05]" : "border-[#e8f3f1]/10 bg-[#e8f3f1]/[0.03]"
                )}
              >
                <button
                  type="button"
                  aria-label={`Give a star to ${v.label}`}
                  onClick={(e) => change(v.id, 1, e.currentTarget)}
                  className="absolute inset-0 z-0 cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f2c14e]/60"
                />
                {hasStars ? (
                  <motion.span
                    aria-hidden={true}
                    className="pointer-events-none absolute inset-y-0 left-0 w-full origin-left bg-[#f2c14e]/[0.10]"
                    initial={false}
                    animate={{ scaleX: v.count === 0 ? 0 : Math.max(v.bar, 0.06) }}
                    transition={reduced ? { duration: 0 } : { duration: 0.7, ease: EASE_HOUSE }}
                  />
                ) : null}
                <div className="pointer-events-none relative flex items-center gap-3.5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[#f2c14e]/30 bg-[#0b1120]">
                    <Icon className="size-5 text-[#f2c14e]" aria-hidden={true} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[#e8f3f1]">{v.label}</p>
                    <p className="mt-0.5 text-sm leading-snug text-[#9aada8]">{v.blurb.charAt(0).toUpperCase() + v.blurb.slice(1)}.</p>
                  </div>
                  {view.showNumbers && v.share !== null ? (
                    <span className="hidden w-11 text-right font-[family-name:var(--font-display)] text-lg tabular-nums text-[#e8f3f1] sm:block">{v.share}%</span>
                  ) : null}
                  {stars(v.id, v.label)}
                </div>
              </motion.li>
            );
          })}
        </ul>
      </div>

      <p className="mt-4 text-center text-sm text-[#9aada8]">
        {view.showNumbers
          ? `${tally.voters.toLocaleString("en-US")} people have voted. Tap a feature to place a star; tap a star to take it back.`
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
