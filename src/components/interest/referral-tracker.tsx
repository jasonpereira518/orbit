"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { PlanetArt } from "@/components/interest/planet-art";
import { RollingCount } from "@/components/interest/proof-line";
import {
  REFERRAL_TIERS,
  TRACKER_SLOTS,
  referralLine,
  spotsEarned,
  tierFor,
  type ReferralTierId,
} from "@/lib/interest-list";
import { publishProgress, usePassProgress } from "@/lib/interest-progress-store";
import { EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { WelcomePlanet } from "@/lib/welcome-planets";

/** How often an open pass asks whether a friend has joined. */
const POLL_MS = 20_000;
/** Ticks closer together than this are one tick: a tab coming forward fires several events. */
const MIN_GAP_MS = 3_000;
/** Stagger between circles that fill together. Matches the pass's old moon drop. */
const STAGGER_S = 0.09;
const SEEN_KEY = "waitlist-tracker-seen:";
/** How long a freshly unlocked tier keeps its highlight. */
const FLASH_MS = 2200;

const MILESTONES = new Set(REFERRAL_TIERS.filter((t) => t.at > 0).map((t) => t.at));

/**
 * One planet per tier, escalating: a small dull Mercury for the waitlist itself, up through
 * Earth, Jupiter and ringed Saturn, to the sun for founding member. Same art the pass and the
 * landing hero use (`PlanetArt`, `public/landing/planets/`) — this is not a signup's planet,
 * so it never touches `WelcomePlanet`'s join-order meaning. Box sizes stay fixed so the row
 * aligns; the art itself grows tier over tier.
 */
const TIER_ART: Record<ReferralTierId, { planet: WelcomePlanet | "sun"; size: number }> = {
  joined: { planet: "mercury", size: 20 },
  "move-up": { planet: "earth", size: 26 },
  "priority-beta": { planet: "jupiter", size: 34 },
  "early-access": { planet: "saturn", size: 44 },
  founding: { planet: "sun", size: 48 },
};
const PLANET_BOX = 52;

function TierPlanet({ tierId, unlocked }: { tierId: ReferralTierId; unlocked: boolean }) {
  const art = TIER_ART[tierId];
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center transition-all duration-700"
      style={{
        width: PLANET_BOX,
        height: PLANET_BOX,
        opacity: unlocked ? 1 : 0.4,
        filter: unlocked ? "none" : "grayscale(0.85)",
      }}
    >
      {art.planet === "sun" ? (
        <picture>
          <source type="image/avif" srcSet="/landing/planets/sun.avif" />
          <source type="image/webp" srcSet="/landing/planets/sun.webp" />
          <img
            src="/landing/planets/sun.png"
            alt=""
            width={art.size}
            height={art.size}
            draggable={false}
            style={{
              width: art.size,
              height: art.size,
              objectFit: "contain",
              filter: unlocked ? "drop-shadow(0 0 12px rgba(242,193,78,0.65))" : "none",
            }}
          />
        </picture>
      ) : (
        <PlanetArt planet={art.planet} size={art.size} />
      )}
    </span>
  );
}

function readSeen(token: string): number | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY + token);
    const n = raw === null ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeSeen(token: string, n: number) {
  try {
    window.localStorage.setItem(SEEN_KEY + token, String(n));
  } catch {
    // Private mode or blocked storage: the fill just replays next visit.
  }
}

/**
 * Ten empty circles, one per friend, filling in gold as friends join through your link, with
 * the perks each milestone unlocks below. It is the whole referral programme on one card, and
 * it works before you have a pass too: the circles stay empty and the perks say what a link
 * would earn.
 *
 * LIVE. The page is rendered once, so a friend joining while you watch would only show after
 * a reload. While a pass is open this polls `/api/interest-list/progress` every 20 seconds
 * (and once when the tab comes back into view), and publishes to the progress store, which
 * the boarding pass also reads. A 404 (a pass that no longer exists, or a made-up one) stops
 * the polling for good.
 *
 * ANIMATION. Only circles you have not seen fill are animated. What was already filled the
 * last time this pass was shown (remembered in localStorage) just is; new circles pop in on
 * a 90 ms stagger with one ripple, and start when the card is on screen. Every animated
 * circle is rendered filled in the server HTML and only hides itself after mount, so a
 * JS-less page and a reduced-motion visitor see the true state. Reduced motion is read from
 * `matchMedia` in the mount effect, not from `usePrefersReducedMotion`, whose first value is
 * always false.
 */
export function ReferralTracker({
  token,
  referrals: initialReferrals,
  position: initialPosition,
  joinHref,
}: {
  /** The visitor's pass token, or null before they have joined. */
  token: string | null;
  referrals: number;
  position: number | null;
  /** Where "join" points: the hero's form, on this page. */
  joinHref: string;
}) {
  const serverProgress = useMemo(
    () => ({ token, referrals: initialReferrals, position: initialPosition }),
    [token, initialReferrals, initialPosition]
  );
  const progress = usePassProgress(serverProgress);
  const activeToken = progress.token;
  const referrals = Math.min(Math.max(progress.referrals, 0), TRACKER_SLOTS);
  const position = progress.position;

  const rowRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rowRef, { once: true, amount: 0.6 });
  const [motionOk, setMotionOk] = useState(false);
  /** How many circles were already filled the last time this pass was shown. Null until read. */
  const [seen, setSeen] = useState<number | null>(null);
  const [flash, setFlash] = useState<ReferralTierId | null>(null);
  const latestReferrals = useRef(referrals);
  const previousReferrals = useRef<number | null>(null);

  // Declared before the mount effect so it holds the current count when that one reads it.
  useEffect(() => {
    latestReferrals.current = referrals;
  }, [referrals]);

  // Mount: which circles are news? Everything below `seen` renders as plain filled.
  useEffect(() => {
    const ok = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMotionOk(ok);
    if (!activeToken) {
      setSeen(0);
      return;
    }
    const stored = readSeen(activeToken);
    const now = latestReferrals.current;
    if (!ok) {
      setSeen(now);
      writeSeen(activeToken, now);
    } else {
      setSeen(Math.min(stored ?? 0, now));
    }
  }, [activeToken]);

  // Once the fill has had time to play, it is no longer news.
  useEffect(() => {
    if (!activeToken || seen === null || !motionOk || !inView || referrals <= seen) return;
    const done = window.setTimeout(
      () => {
        setSeen(referrals);
        writeSeen(activeToken, referrals);
      },
      (referrals - seen) * STAGGER_S * 1000 + 1000
    );
    return () => window.clearTimeout(done);
  }, [activeToken, seen, motionOk, inView, referrals]);

  // A tier crossed while you watch gets a highlight. Never on the first read.
  useEffect(() => {
    const before = previousReferrals.current;
    previousReferrals.current = referrals;
    if (before === null || referrals <= before) return;
    const crossed = REFERRAL_TIERS.filter((t) => t.at > before && t.at <= referrals);
    const top = crossed[crossed.length - 1];
    if (!top) return;
    setFlash(top.id);
    const clear = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(clear);
  }, [referrals]);

  // The poll. Ticks while the tab is hidden do nothing; coming back fetches at once.
  useEffect(() => {
    if (!activeToken) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let lastAt = 0;

    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (Date.now() - lastAt < MIN_GAP_MS) return;
      lastAt = Date.now();
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(`/api/interest-list/progress?token=${encodeURIComponent(activeToken)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.status === 404) {
          stopped = true;
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; referrals?: number; position?: number };
        if (data.ok && typeof data.referrals === "number" && typeof data.position === "number") {
          publishProgress({ token: activeToken, referrals: data.referrals, position: data.position });
        }
      } catch {
        // Offline or aborted: the next tick tries again.
      }
    };

    const interval = window.setInterval(() => void tick(), POLL_MS);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeToken]);

  const { current: tier, next: nextTier } = tierFor(referrals);
  const earned = spotsEarned(referrals);

  return (
    <div className="referral-tracker-glass mx-auto max-w-3xl rounded-3xl px-5 py-8 sm:px-8 sm:py-10">
      <div
        ref={rowRef}
        role="img"
        aria-label={`${referrals} of ${TRACKER_SLOTS} friends joined`}
        className="flex justify-center gap-2 pb-7 sm:gap-3"
      >
        {Array.from({ length: TRACKER_SLOTS }, (_, i) => {
          const filled = i < referrals;
          const news = filled && seen !== null && motionOk && i >= seen;
          const milestone = MILESTONES.has(i + 1);
          return (
            <span key={i} aria-hidden="true" className="relative flex size-6 items-center justify-center sm:size-9">
              {milestone ? (
                <span className="absolute -inset-1 rounded-full border border-[#f2c14e]/25" />
              ) : null}
              {news ? (
                <>
                  <motion.span
                    className="absolute inset-0 rounded-full border border-[#f2c14e]"
                    initial={{ scale: 1, opacity: 0 }}
                    animate={inView ? { scale: [1, 2.4], opacity: [0.7, 0] } : { scale: 1, opacity: 0 }}
                    transition={{ duration: 0.9, ease: EASE_HOUSE, delay: (i - seen) * STAGGER_S + 0.2 }}
                  />
                  <motion.span
                    className="absolute inset-0 rounded-full bg-[#f2c14e] shadow-[0_0_14px_rgba(242,193,78,0.85)]"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={inView ? { scale: [0, 1.3, 1], opacity: 1 } : { scale: 0, opacity: 0 }}
                    transition={{
                      duration: 0.6,
                      ease: EASE_HOUSE,
                      times: [0, 0.6, 1],
                      delay: (i - seen) * STAGGER_S,
                    }}
                  />
                </>
              ) : (
                <span
                  className={cn(
                    "absolute inset-0 rounded-full",
                    filled
                      ? "bg-[#f2c14e] shadow-[0_0_14px_rgba(242,193,78,0.85)]"
                      : "border border-[#f2c14e]/55"
                  )}
                />
              )}
              {milestone ? (
                <span className="absolute -bottom-6 text-[11px] tabular-nums text-[#9aada8]">{i + 1}</span>
              ) : null}
            </span>
          );
        })}
      </div>

      {activeToken && position ? (
        <div className="mt-2 text-center">
          <p className="text-xs uppercase tracking-[0.14em] text-[#9aada8]">You&apos;re number</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-[56px] leading-none tracking-tight text-[#e8f3f1]">
            <RollingCount value={position} />
          </p>
          <p className="mt-2 text-sm text-[#9aada8]">
            in line
            {tier.at > 0 ? <span className="text-[#f2c14e]"> · {tier.label}</span> : null}
          </p>
          {earned > 0 ? (
            <motion.p
              key={earned}
              className="mt-2 text-sm text-[#f2c14e]"
              initial={motionOk ? { y: 8, opacity: 0 } : false}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4, ease: EASE_HOUSE }}
            >
              {earned} spots earned
            </motion.p>
          ) : null}
          <p aria-live="polite" className="mt-3 text-sm text-[#9aada8]">
            {referralLine(referrals)}
          </p>
        </div>
      ) : (
        <p aria-live="polite" className="mt-2 text-center text-base text-[#e8f3f1]">
          {referralLine(referrals)}
          <span className="mt-1.5 block text-sm text-[#9aada8]">
            <a href={joinHref} className="text-[#f2c14e] underline-offset-4 hover:underline">
              Join the waitlist
            </a>{" "}
            to get your link.
          </span>
        </p>
      )}

      <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {REFERRAL_TIERS.map((t, i) => {
          const unlocked = referrals >= t.at;
          const active = t.id === tier.id && t.at > 0;
          const isNext = nextTier?.id === t.id;
          const prevAt = REFERRAL_TIERS[i - 1]?.at ?? 0;
          const pct = isNext ? Math.round(((referrals - prevAt) / (t.at - prevAt)) * 100) : 0;
          return (
            <li
              key={t.id}
              aria-current={active ? "step" : undefined}
              className={cn(
                "rounded-2xl border px-4 py-3.5 transition-colors duration-700",
                flash === t.id
                  ? "border-[#f2c14e] bg-[#f2c14e]/15"
                  : unlocked
                    ? "border-[#f2c14e]/35 bg-[#f2c14e]/[0.06]"
                    : isNext
                      ? "border-[#f2c14e]/60"
                      : "border-[#e8f3f1]/12"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <TierPlanet tierId={t.id} unlocked={unlocked} />
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#9aada8]">
                  {t.at === 0 ? "Start" : `${t.at} ${t.at === 1 ? "friend" : "friends"}`}
                </p>
              </div>
              <p className="mt-2.5 text-sm font-medium text-[#e8f3f1]">{t.label}</p>
              <p className="mt-1 text-xs leading-relaxed text-[#9aada8]">{t.blurb}</p>
              {unlocked ? (
                <p className="mt-3 text-xs text-[#f2c14e]">Unlocked</p>
              ) : isNext ? (
                <>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#e8f3f1]/14">
                    <div
                      className="h-full rounded-full bg-[#f2c14e] transition-[width] duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-[#9aada8]">
                    {t.at - referrals} more {t.at - referrals === 1 ? "friend" : "friends"}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-xs text-[#9aada8]">{t.at - referrals} to go</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
