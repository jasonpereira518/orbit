"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ComponentType } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bell, Calendar, MessageSquare, Minus, Network, Plug, Plus, Send, Star } from "lucide-react";
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
  topPick,
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

/** Stills of the demo (`public/waitlist/tour/`) for the options that have a screen to show. */
const STILLS: Partial<Record<PollOptionId, { name: string; alt: string }>> = {
  "constellation-map": { name: "constellation", alt: "A star chart of a network, with one person's card open." },
  "network-chat": { name: "draft", alt: "An answer about a promise made to a contact, with a drafted email ready to send." },
  "auto-integrations": { name: "timeline", alt: "One contact's timeline: an email, a meeting, a LinkedIn message and a call." },
  "smart-follow-ups": { name: "suggestion", alt: "A suggestion to reach out to someone who has gone quiet." },
};

/**
 * Where an orb sits, by rank: the leader in the middle, the rest around it. Percent of the
 * field (x, y) — the orb's disc is centred on the point.
 */
const SLOTS: readonly (readonly [number, number])[] = [
  [50, 44],
  [21, 22],
  [79, 20],
  [14, 62],
  [86, 60],
  [50, 79],
];
const FIELD_H = 440;
/** The disc's height at scale 1, and the room reserved for it above the orb's label. */
const DISC = 64;
const DISC_ROOM = 104;

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
 * Desktop draws the features as an icon field: six glowing orbs that grow and brighten with
 * their share of the stars, the leader drifting to the middle, your own stars as pips. Tap an
 * orb for its card (the full description, a still from the demo, − and + stars). Phones get a
 * plain list with the same icons, full wrapping descriptions and the same controls. Both are
 * rendered and `md:` picks one, so nothing waits on hydration to choose.
 *
 * STATE. `server` is the last tally and allocation the server confirmed; `mine` is what the
 * visitor has now. The tally on screen is `server.results` with `mine` swapped in for
 * `server.mine`, so a tap moves the orbs at once, and a live refresh of the tally never
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
 * `useReducedMotion`: orbs jump to their places and sizes.
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
  const [selected, setSelected] = useState<PollOptionId>(() => topPick(initial.allocation) ?? POLL_OPTIONS[0].id);

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

  const sel = POLL_OPTIONS.find((o) => o.id === selected) ?? POLL_OPTIONS[0];
  const selView = byId.get(sel.id)!;
  const SelIcon = POLL_ICONS[sel.id];
  const still = STILLS[sel.id];
  const glide = reduced ? { duration: 0 } : SPRING_SOFT;

  const controls = (id: PollOptionId, label: string, className?: string) => {
    const n = mine[id] ?? 0;
    const btn =
      "flex size-8 items-center justify-center rounded-full border border-[#e8f3f1]/[0.16] text-[#e8f3f1] transition-colors hover:border-[#f2c14e]/60 hover:bg-[#f2c14e]/10 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60";
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        <button
          type="button"
          className={btn}
          disabled={n === 0}
          aria-label={`Take a star back from ${label}`}
          onClick={() => change(id, -1)}
        >
          <Minus className="size-3.5" aria-hidden={true} />
        </button>
        <span className="flex min-w-9 items-center justify-center gap-0.5 text-sm tabular-nums text-[#f2c14e]" aria-label={`${n} of your stars on ${label}`}>
          <Star className="size-3.5 fill-current" aria-hidden={true} />
          {n}
        </span>
        <button
          type="button"
          className={btn}
          aria-label={`Give a star to ${label}`}
          onClick={(e) => change(id, 1, e.currentTarget)}
        >
          <Plus className="size-3.5" aria-hidden={true} />
        </button>
      </div>
    );
  };

  return (
    // Same deep-navy panel as the referral tracker (`.feature-poll-panel` / shared interest panel).
    <div ref={rootRef} className="landing-glass feature-poll-panel mx-auto w-full max-w-2xl rounded-3xl p-4 sm:p-6">
      <div role="group" aria-label="Which features do you want first? Spend your stars.">
        <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">Feature poll</p>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
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

        {/* Desktop: the icon field. */}
        <div className="mt-4 hidden md:block">
          <div className="relative w-full" style={{ height: FIELD_H }}>
            {POLL_OPTIONS.map((opt, index) => {
              const v = byId.get(opt.id)!;
              const slot = SLOTS[hasStars ? v.rank - 1 : index] ?? SLOTS[SLOTS.length - 1]!;
              const Icon = POLL_ICONS[opt.id];
              const scale = hasStars ? 0.75 + 0.75 * v.bar : 1;
              const glow = hasStars ? v.bar : 0.25;
              const mineN = mine[opt.id] ?? 0;
              const isSel = sel.id === opt.id;
              return (
                <div
                  key={opt.id}
                  className="poll-orb absolute flex w-32 -translate-x-1/2 flex-col items-center"
                  style={{ left: `${slot[0]}%`, top: `${slot[1]}%`, marginTop: -DISC_ROOM / 2 }}
                >
                  <button
                    type="button"
                    aria-pressed={isSel}
                    aria-label={`${opt.label}${mineN ? `, ${STAR_LEFT(mineN)} from you` : ""}`}
                    onClick={() => setSelected(opt.id)}
                    className="group flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60"
                    style={{ width: DISC_ROOM, height: DISC_ROOM }}
                  >
                    <span
                      className={cn(
                        "poll-orb-disc flex items-center justify-center rounded-full border bg-[#0b1120]",
                        isSel ? "border-[#f2c14e]" : mineN ? "border-[#f2c14e]/60" : "border-[#e8f3f1]/20 group-hover:border-[#f2c14e]/50"
                      )}
                      style={{
                        width: DISC,
                        height: DISC,
                        transform: `scale(${scale})`,
                        boxShadow: `0 0 ${10 + 34 * glow}px rgba(242,193,78,${0.12 + 0.5 * glow}), inset 0 0 12px rgba(242,193,78,${0.05 + 0.2 * glow})`,
                      }}
                    >
                      <Icon className={cn("size-7", hasStars && v.bar > 0.3 ? "text-[#ffe9a0]" : "text-[#cfe3dd]")} aria-hidden={true} />
                    </span>
                  </button>
                  {/* The label rides up with the disc as it shrinks, so a small orb keeps its name
                      close instead of floating above a gap sized for the biggest one. */}
                  <div
                    className="poll-orb-label flex flex-col items-center"
                    style={{ transform: `translateY(${-(DISC_ROOM / 2 - 6 - (DISC / 2) * scale)}px)` }}
                  >
                  <span className="mt-1 text-center text-xs font-medium leading-tight text-[#e8f3f1]">{opt.label}</span>
                  <span className="mt-1 flex h-4 items-center gap-0.5" aria-hidden={true}>
                    {Array.from({ length: Math.min(mineN, 6) }, (_, i) => (
                      <Star key={i} className="size-3 fill-[#f2c14e] text-[#f2c14e]" />
                    ))}
                    {mineN > 6 ? <span className="text-[10px] text-[#f2c14e]">+{mineN - 6}</span> : null}
                    {view.showNumbers && v.share !== null ? (
                      <span className="ml-1 text-[10px] tabular-nums text-[#9aada8]">{v.share}%</span>
                    ) : null}
                  </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* The selected feature's card. */}
          <div aria-live="polite" className="mt-2 rounded-2xl border border-[#e8f3f1]/10 bg-[#e8f3f1]/[0.03] p-4">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-[family-name:var(--font-display)] text-xl text-[#e8f3f1]">
                  <SelIcon className="size-5 text-[#f2c14e]" aria-hidden={true} />
                  {sel.label}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">
                  {sel.blurb.charAt(0).toUpperCase() + sel.blurb.slice(1)}.
                </p>
                <p className="mt-2 text-xs text-[#6d807c]">
                  {selView.count === 0
                    ? "No stars yet."
                    : `${selView.count} ${selView.count === 1 ? "star" : "stars"} so far${view.showNumbers && selView.share !== null ? ` · ${selView.share}% of the vote` : ""}`}
                  {hasStars && selView.rank === 1 ? " · leading" : ""}
                </p>
                {controls(sel.id, sel.label, "mt-3")}
              </div>
              {still && near ? (
                <div className="hidden w-[168px] shrink-0 overflow-hidden rounded-xl border border-[#e8f3f1]/10 lg:block">
                  {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized WebP pair with its own srcset */}
                  <img
                    key={still.name}
                    src={`/waitlist/tour/${still.name}-420.webp`}
                    srcSet={`/waitlist/tour/${still.name}-420.webp 420w, /waitlist/tour/${still.name}-840.webp 840w`}
                    sizes="168px"
                    width={420}
                    height={315}
                    alt={still.alt}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="block h-auto w-full select-none"
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Phones: the list. */}
        <ul className="mt-4 grid gap-3 md:hidden">
          {(hasStars ? view.options : POLL_OPTIONS.map((o) => byId.get(o.id)!)).map((v) => {
            const Icon = POLL_ICONS[v.id];
            const mineN = mine[v.id] ?? 0;
            return (
              <motion.li
                key={v.id}
                layout="position"
                transition={glide}
                className={cn(
                  "relative min-w-0 overflow-hidden rounded-2xl border px-4 py-3.5",
                  mineN ? "border-[#f2c14e]/45 bg-[#f2c14e]/[0.05]" : "border-[#e8f3f1]/10 bg-[#e8f3f1]/[0.03]"
                )}
              >
                {hasStars ? (
                  <motion.span
                    aria-hidden={true}
                    className="absolute inset-y-0 left-0 w-full origin-left bg-[#f2c14e]/[0.10]"
                    initial={false}
                    animate={{ scaleX: v.count === 0 ? 0 : Math.max(v.bar, 0.06) }}
                    transition={reduced ? { duration: 0 } : { duration: 0.7, ease: EASE_HOUSE }}
                  />
                ) : null}
                <div className="relative flex items-start gap-3">
                  <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border border-[#f2c14e]/30 bg-[#0b1120]">
                    <Icon className="size-5 text-[#f2c14e]" aria-hidden={true} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[#e8f3f1]">{v.label}</p>
                    <p className="mt-0.5 text-sm leading-snug text-[#9aada8]">
                      {v.blurb.charAt(0).toUpperCase() + v.blurb.slice(1)}.
                    </p>
                    <div className="mt-2.5 flex items-center justify-between gap-3">
                      {controls(v.id, v.label)}
                      <span className="text-xs tabular-nums text-[#9aada8]">
                        {v.count} {v.count === 1 ? "star" : "stars"}
                        {view.showNumbers && v.share !== null ? ` · ${v.share}%` : ""}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.li>
            );
          })}
        </ul>
      </div>

      <p className="mt-4 text-center text-sm text-[#9aada8]">
        {view.showNumbers
          ? `${tally.voters.toLocaleString("en-US")} people have voted. Tap a feature to see it.`
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
