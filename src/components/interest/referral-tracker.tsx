"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { Lock } from "lucide-react";
import { PlanetArt } from "@/components/interest/planet-art";
import { TIER_ART } from "@/components/interest/tier-art";
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
import { usePendingInvites } from "@/lib/pass-invites";
import { pulseStarfield } from "@/lib/starfield-events";
import { EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { WelcomePlanet } from "@/lib/welcome-planets";

/** How often an open pass asks whether a friend has joined. */
const POLL_MS = 20_000;
/** While the tab is hidden: slow enough to cost nothing, quick enough for the title badge. */
const HIDDEN_POLL_MS = 60_000;
/** Ticks closer together than this are one tick: a tab coming forward fires several events. */
const MIN_GAP_MS = 3_000;
/** Stagger between circles that fill together. Matches the pass's old moon drop. */
const STAGGER_S = 0.09;
/** Fill seats in this long; settle-timeout adds a little headroom for the ripple. */
const FILL_S = 0.48;
/** How long a freshly unlocked tier keeps its highlight. */
const FLASH_MS = 2200;

const MILESTONES = new Set(REFERRAL_TIERS.filter((t) => t.at > 0).map((t) => t.at));

/** Bright yellow fill — brighter than the landing gold accent alone. */
const FILLED_GLOW =
  "bg-[#ffe566] shadow-[0_0_28px_rgba(255,229,102,0.95),0_0_10px_rgba(242,193,78,0.7)]";
/** A filled circle that knows whose it is: the friend's planet on a dark disc, gold-ringed. */
const FRIEND_DISC =
  "flex items-center justify-center bg-[#0b1120] ring-1 ring-[#ffe566]/70 shadow-[0_0_16px_rgba(255,229,102,0.5)]";
const EMPTY_RING =
  "border border-[#f2c14e]/55 shadow-[0_0_10px_rgba(242,193,78,0.22),inset_0_0_6px_rgba(242,193,78,0.14)]";

const PLANET_BOX = 52;
/** One empty list for every render: `usePassProgress` needs a stable server snapshot. */
const NO_PLANETS: readonly WelcomePlanet[] = [];

/** A friend's planet sized to its circle: drawn at the desktop size, scaled down on phones. */
function FriendPlanet({ planet }: { planet: WelcomePlanet }) {
  return (
    <span className="flex scale-[0.625] items-center justify-center sm:scale-100">
      <PlanetArt planet={planet} size={30} />
    </span>
  );
}

function TierPlanet({
  tierId,
  unlocked,
  isNext,
  float,
  flashing,
  floatIndex,
}: {
  tierId: ReferralTierId;
  unlocked: boolean;
  isNext: boolean;
  /** Slow bob — only when motion is allowed. */
  float: boolean;
  flashing: boolean;
  floatIndex: number;
}) {
  const art = TIER_ART[tierId];
  const glow = unlocked
    ? art.planet === "sun"
      ? "drop-shadow(0 0 16px rgba(242,193,78,0.75))"
      : "drop-shadow(0 0 10px rgba(242,193,78,0.45))"
    : "none";

  return (
    <motion.span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center transition-[opacity,filter] duration-700"
      style={{
        width: PLANET_BOX,
        height: PLANET_BOX,
        opacity: unlocked ? 1 : isNext ? 0.75 : 0.32,
        filter: unlocked ? "none" : isNext ? "grayscale(0.35)" : "grayscale(1)",
      }}
      animate={flashing ? { scale: [1, 1.08, 1] } : { scale: 1 }}
      transition={
        flashing
          ? { duration: 0.55, ease: EASE_HOUSE, times: [0, 0.45, 1] }
          : { duration: 0.4, ease: EASE_HOUSE }
      }
    >
      {/* The bob is a CSS animation on its own box, not a motion loop: a `repeat: Infinity`
          motion value ran on the main thread every frame of the page's life, offscreen
          included, and restyled the planet each time. A CSS transform runs on the compositor. */}
      <span
        className={cn("inline-flex items-center justify-center", float && "tracker-planet-bob")}
        style={float ? { animationDelay: `${floatIndex * 0.45}s` } : undefined}
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
                filter: glow,
              }}
            />
          </picture>
        ) : (
          <span style={{ filter: glow }}>
            <PlanetArt planet={art.planet} size={art.size} />
          </span>
        )}
      </span>
    </motion.span>
  );
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
 * ANIMATION. Every reload (and every live increase) fills circles in order from 0 through
 * the current count — gold grows into the empty ring with a soft settle and a light ripple,
 * on a 90 ms stagger, starting when the card is on screen. Server HTML and reduced-motion
 * visitors see the true filled state with no motion. Reduced motion is read from
 * `matchMedia` in the mount effect, not from `usePrefersReducedMotion`, whose first value
 * is always false.
 */
export function ReferralTracker({
  token,
  referrals: initialReferrals,
  position: initialPosition,
  friendPlanets: initialPlanets = NO_PLANETS,
  joinHref,
}: {
  /** The visitor's pass token, or null before they have joined. */
  token: string | null;
  referrals: number;
  position: number | null;
  /** Friends' planets in join order, from the server render; the poll keeps them current. */
  friendPlanets?: readonly WelcomePlanet[];
  /** Where "join" points: the hero's form, on this page. */
  joinHref: string;
}) {
  const serverProgress = useMemo(
    () => ({ token, referrals: initialReferrals, position: initialPosition, friendPlanets: initialPlanets }),
    [token, initialReferrals, initialPosition, initialPlanets]
  );
  const progress = usePassProgress(serverProgress);
  const activeToken = progress.token;
  const referrals = Math.min(Math.max(progress.referrals, 0), TRACKER_SLOTS);
  const position = progress.position;
  const planets = progress.friendPlanets ?? [];
  /** Completed shares still waiting on a friend: drawn as "invited" circles after the filled. */
  const invited = Math.min(usePendingInvites(activeToken), TRACKER_SLOTS - referrals);

  const rowRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rowRef, { once: true, amount: 0.6 });
  const [motionOk, setMotionOk] = useState(false);
  /**
   * Circles at index < animatedUpTo are already settled as filled. Null until the mount
   * effect reads reduced-motion: then 0 (replay every load) or `referrals` (no motion).
   */
  const [animatedUpTo, setAnimatedUpTo] = useState<number | null>(null);
  const [flash, setFlash] = useState<ReferralTierId | null>(null);
  const previousReferrals = useRef<number | null>(null);

  // Mount: always replay from 0 when motion is allowed; snap when reduced.
  useEffect(() => {
    const ok = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMotionOk(ok);
    setAnimatedUpTo(ok ? 0 : referrals);
    // referrals intentionally omitted — reload replay starts at 0 (or snaps once).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount / token-change only
  }, [activeToken]);

  // After the staggered fills finish, treat those circles as settled (live updates still fill).
  useEffect(() => {
    if (animatedUpTo === null || !motionOk || !inView || referrals <= animatedUpTo) return;
    const done = window.setTimeout(
      () => setAnimatedUpTo(referrals),
      (referrals - animatedUpTo) * STAGGER_S * 1000 + FILL_S * 1000 + 350
    );
    return () => window.clearTimeout(done);
  }, [animatedUpTo, motionOk, inView, referrals]);

  // A tier crossed while you watch gets a highlight. Never on the first read.
  useEffect(() => {
    const before = previousReferrals.current;
    previousReferrals.current = referrals;
    if (before === null || referrals <= before) return;
    burstFromCircle(rowRef.current, referrals - 1);
    const crossed = REFERRAL_TIERS.filter((t) => t.at > before && t.at <= referrals);
    const top = crossed[crossed.length - 1];
    if (!top) return;
    setFlash(top.id);
    const clear = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(clear);
  }, [referrals]);

  // The poll. While the tab is hidden it slows to one read a minute (enough for the pass's
  // tab-title badge); coming back fetches at once.
  useEffect(() => {
    if (!activeToken) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let lastAt = 0;

    const tick = async () => {
      if (stopped) return;
      const gap = document.visibilityState === "visible" ? MIN_GAP_MS : HIDDEN_POLL_MS;
      if (Date.now() - lastAt < gap) return;
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
        const data = (await res.json()) as {
          ok?: boolean;
          referrals?: number;
          position?: number;
          friendPlanets?: WelcomePlanet[];
        };
        if (data.ok && typeof data.referrals === "number" && typeof data.position === "number") {
          publishProgress({
            token: activeToken,
            referrals: data.referrals,
            position: data.position,
            friendPlanets: Array.isArray(data.friendPlanets) ? data.friendPlanets : [],
          });
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
        aria-label={`${referrals} of ${TRACKER_SLOTS} friends joined${invited > 0 ? `, ${invited} invited` : ""}`}
        className="flex justify-center gap-2 pb-7 sm:gap-3"
      >
        {Array.from({ length: TRACKER_SLOTS }, (_, i) => {
          const filled = i < referrals;
          const filling =
            filled && animatedUpTo !== null && motionOk && i >= animatedUpTo;
          const fillDelay = animatedUpTo === null ? 0 : (i - animatedUpTo) * STAGGER_S;
          const milestone = MILESTONES.has(i + 1);
          return (
            <span key={i} aria-hidden="true" className="relative flex size-6 items-center justify-center sm:size-9">
              {milestone ? (
                <span
                  className={cn(
                    "absolute -inset-1 rounded-full border",
                    filled ? "border-[#ffe566]/60 shadow-[0_0_14px_rgba(255,229,102,0.4)]" : "border-[#f2c14e]/25"
                  )}
                />
              ) : null}
              {filling ? (
                <>
                  {/* Vessel stays visible so the gold reads as filling the ring, not popping in. */}
                  <span className={cn("absolute inset-0 rounded-full", EMPTY_RING)} />
                  <motion.span
                    className={cn("absolute inset-0 rounded-full", planets[i] ? FRIEND_DISC : FILLED_GLOW)}
                    initial={{ transform: "scale(0.55)", opacity: 0 }}
                    animate={
                      inView
                        ? { transform: ["scale(0.55)", "scale(1.08)", "scale(1)"], opacity: [0, 1, 1] }
                        : { transform: "scale(0.55)", opacity: 0 }
                    }
                    transition={{
                      duration: FILL_S,
                      ease: EASE_HOUSE,
                      times: [0, 0.62, 1],
                      delay: fillDelay,
                    }}
                  >
                    {planets[i] ? <FriendPlanet planet={planets[i]} /> : null}
                  </motion.span>
                  <motion.span
                    className="absolute inset-0 rounded-full border-2 border-[#ffe566]"
                    initial={{ transform: "scale(1)", opacity: 0 }}
                    animate={
                      inView
                        ? { transform: ["scale(1)", "scale(2.15)"], opacity: [0.55, 0] }
                        : { transform: "scale(1)", opacity: 0 }
                    }
                    transition={{ duration: 0.65, ease: EASE_HOUSE, delay: fillDelay + 0.2 }}
                  />
                </>
              ) : !filled && i < referrals + invited ? (
                // Invited: a share went out for this circle. It draws in when it appears,
                // and the fill above takes over when the friend joins.
                <motion.span
                  className="absolute inset-0 flex items-center justify-center rounded-full border-2 border-dashed border-[#f2c14e] bg-[#f2c14e]/[0.08] shadow-[0_0_12px_rgba(242,193,78,0.3)]"
                  initial={motionOk ? { opacity: 0, scale: 0.6 } : false}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.4, ease: EASE_HOUSE }}
                >
                  <span className="size-1.5 rounded-full bg-[#f2c14e] shadow-[0_0_6px_rgba(242,193,78,0.9)]" />
                </motion.span>
              ) : (
                <span
                  className={cn(
                    "absolute inset-0 rounded-full",
                    filled ? (planets[i] ? FRIEND_DISC : FILLED_GLOW) : EMPTY_RING
                  )}
                >
                  {filled && planets[i] ? <FriendPlanet planet={planets[i]} /> : null}
                </span>
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
          {invited > 0 ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-[#f2c14e]/90">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-[#f2c14e]" />
              {invited === 1 ? "1 invite out" : `${invited} invites out`} — each friend who joins fills one.
            </p>
          ) : null}
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
          const isFlash = flash === t.id;
          const prevAt = REFERRAL_TIERS[i - 1]?.at ?? 0;
          const pct = isNext ? Math.round(((referrals - prevAt) / (t.at - prevAt)) * 100) : 0;
          return (
            <li
              key={t.id}
              aria-current={active ? "step" : undefined}
              className={cn(
                "relative rounded-2xl border px-4 py-3.5 transition-[color,background-color,border-color,box-shadow,transform] duration-700",
                isFlash
                  ? "border-[#f2c14e] bg-[#f2c14e]/22 shadow-[0_0_28px_rgba(242,193,78,0.35),inset_0_0_20px_rgba(242,193,78,0.08)]"
                  : unlocked
                    ? "border-[#f2c14e]/50 bg-[#f2c14e]/[0.12] motion-safe:hover:-translate-y-0.5 motion-safe:hover:border-[#f2c14e]/70 motion-safe:hover:duration-(--transition-duration-fast)"
                    : isNext
                      ? "border-[#f2c14e]/75 bg-[#f2c14e]/[0.04] shadow-[0_0_20px_rgba(242,193,78,0.18)] motion-safe:hover:-translate-y-0.5 motion-safe:hover:border-[#f2c14e] motion-safe:hover:duration-(--transition-duration-fast)"
                      : "border-[#e8f3f1]/10 bg-[#e8f3f1]/[0.02] opacity-75"
              )}
            >
              {!unlocked ? (
                <Lock
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-3 right-3 size-3.5 text-[#9aada8]"
                />
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <TierPlanet
                  tierId={t.id}
                  unlocked={unlocked}
                  isNext={isNext}
                  float={motionOk && (unlocked || isNext)}
                  flashing={isFlash && motionOk}
                  floatIndex={i}
                />
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
                      className="h-full w-full origin-left rounded-full bg-[#f2c14e] shadow-[0_0_8px_rgba(242,193,78,0.7)] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
                      style={{ transform: `scaleX(${pct / 100})` }}
                    />
                  </div>
                  <p className="mt-1.5 pr-5 text-xs text-[#9aada8]">
                    {t.at - referrals} more {t.at - referrals === 1 ? "friend" : "friends"}
                  </p>
                </>
              ) : (
                <p className="mt-3 pr-5 text-xs text-[#9aada8]">{t.at - referrals} to go</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A starfield burst from the circle a new friend just filled, when the tracker is what is on
 * screen. The pass bursts from its own planet when IT is on screen, so this stays quiet then:
 * one burst per join.
 */
function burstFromCircle(row: HTMLElement | null, index: number) {
  if (!row || document.visibilityState !== "visible") return;
  const onScreen = (r: DOMRect) => r.bottom > 0 && r.top < window.innerHeight;
  const planet = document.querySelector("[data-pass-planet]");
  if (planet && onScreen(planet.getBoundingClientRect())) return;
  const circle = row.children[index];
  if (!circle) return;
  const r = circle.getBoundingClientRect();
  if (onScreen(r)) pulseStarfield(r.left + r.width / 2, r.top + r.height / 2);
}
