"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Bell } from "lucide-react";
import { PlanetArt } from "@/components/interest/planet-art";
import { RollingCount } from "@/components/interest/proof-line";
import { ShareRow } from "@/components/interest/share-row";
import { TierCelebration } from "@/components/interest/tier-celebration";
import {
  describePassChange,
  liveJoinLine,
  positionLine,
  referralLine,
  tierCrossed,
  tierFor,
  type InterestTicket,
  type ReferralTier,
} from "@/lib/interest-list";
import { notifyJoin, requestNotify, shouldOfferNotify } from "@/lib/join-notify";
import { usePassProgress, type PassProgress } from "@/lib/interest-progress-store";
import { DUR, EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { recordShare, syncInvites } from "@/lib/pass-invites";
import { readSeen, writeSeen } from "@/lib/pass-seen";
import { lightThreadStars, pulseStarfield, threadStarfield } from "@/lib/starfield-events";
import { bumpTitleBadge } from "@/lib/tab-title-badge";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

const PLANET_SIZE = 96;
/** Room around the planet: the stub keeps the height the moon ring used to give it. */
const STUB_SIZE = 148;

function joinedLabel(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * The early-access pass. A stub (planet, place in line) and a
 * details pane (place line, referral line, share tools) with a perforated seam between
 * them; the seam runs vertically from `sm` up and horizontally on phones, where the stub
 * stacks above the details.
 *
 * `entrance: "flip"` is the in-place reveal after a join: everything assembles in order
 * (seam draws, number rolls, planet springs in, lines rise). `"direct"` is a `?me=`
 * visit: the ticket is fully in the HTML and only the number roll plays, once. Reduced
 * motion: everything is simply there.
 *
 * The place in line and the referral line follow the live progress (`usePassProgress`), so
 * they move when the referral tracker's poll finds a new friend.
 *
 * NEWS. One line under the referral line says what changed: on arrival, what moved since
 * this device last showed the pass (`pass-seen.ts`, `describePassChange`); while open, a
 * friend joining through the link (`liveJoinLine`), with a starfield burst from the planet
 * and a "(+1)" tab-title badge if the tab is in the background. Other people's referrals
 * move the number silently — only your own friends get a celebration.
 *
 * SHARES. A completed native share draws a thread from the planet into the sky, ending in a
 * hollow star, and marks the next tracker circle "invited" (`pass-invites.ts`). A friend
 * joining lights the oldest waiting star and consumes one invite.
 *
 * TIERS. A join that crosses 1, 3, 5 or 10 friends — live, or while you were away — gets the
 * full-screen unlock moment (`TierCelebration`), held until the tab is visible. With the
 * visitor's opt-in, a join in a background tab also raises a system notification
 * (`join-notify.ts`).
 */
export function BoardingPass({
  ticket,
  pageUrl,
  entrance,
  headingRef,
}: {
  ticket: InterestTicket;
  /** The waitlist page on its own domain; the share link is built on it. */
  pageUrl: string;
  entrance: "flip" | "direct";
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const reduced = usePrefersReducedMotion();
  const full = entrance === "flip" && !reduced;

  const serverProgress = useMemo(
    (): PassProgress => ({ token: ticket.shareToken, referrals: ticket.referrals, position: ticket.position }),
    [ticket.shareToken, ticket.referrals, ticket.position]
  );
  const progress = usePassProgress(serverProgress);
  // Published progress can belong to a different pass (a second join on the same page).
  const live = progress.token === ticket.shareToken ? progress : serverProgress;
  const position = live.position ?? ticket.position;
  const { current: tier } = tierFor(live.referrals);
  const token = ticket.shareToken;

  const planetRef = useRef<HTMLSpanElement>(null);
  const [news, setNews] = useState<{ text: string; key: number; planet?: WelcomePlanet } | null>(null);
  const [celebration, setCelebration] = useState<{ tier: ReferralTier; friends: number } | null>(null);
  /** An unlock that landed while the tab was hidden, shown when it comes back. */
  const celebrationPending = useRef<{ tier: ReferralTier; friends: number } | null>(null);
  const endCelebration = useCallback(() => setCelebration(null), []);
  /** The pass whose arrival has been read. StrictMode runs effects twice in development, and
   * the second run would read back the record the first just wrote and find nothing new. */
  const arrivalFor = useRef<string | null>(null);
  /** False once unmounted. A flag rather than clearing the timer on cleanup: StrictMode's
   * rehearsal unmount would cancel it, and the run-once guard above would never re-arm it. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const celebrate = useCallback((tier: ReferralTier, friends: number) => {
    if (document.visibilityState === "visible") setCelebration({ tier, friends });
    else celebrationPending.current = { tier, friends };
  }, []);
  /** The referral count this pass last showed; null until the arrival read has run. */
  const shownReferrals = useRef<number | null>(null);
  /** A join that landed while the tab was hidden waits here for the tab to come back. */
  const burstPending = useRef(false);

  // Arrival: what changed since this device last showed this pass. localStorage only exists
  // after hydration, so this cannot be a lazy initial state.
  useEffect(() => {
    if (arrivalFor.current === token) return;
    arrivalFor.current = token;
    const now = { referrals: live.referrals, position };
    const seen = readSeen(token);
    const text = seen ? describePassChange(seen, now) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads client-only storage
    if (text) setNews({ text, key: 0 });
    writeSeen(token, now);
    syncInvites(token, live.referrals);
    shownReferrals.current = live.referrals;
    // A tier crossed while they were away: celebrate once the pass has settled.
    const unlocked = seen ? tierCrossed(seen.referrals, now.referrals) : null;
    if (unlocked) {
      window.setTimeout(() => {
        if (mounted.current) celebrate(unlocked, now.referrals);
      }, 600);
    }
    // Once per pass: live changes are the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live: a friend joined while the page is open.
  useEffect(() => {
    const before = shownReferrals.current;
    if (before === null) return;
    shownReferrals.current = live.referrals;
    writeSeen(token, { referrals: live.referrals, position });
    syncInvites(token, live.referrals);
    const gained = live.referrals - before;
    if (gained <= 0) return;
    lightThreadStars(gained);
    const newest = live.friendPlanets?.[live.referrals - 1];
    setNews((prev) => ({ text: liveJoinLine(gained), key: (prev?.key ?? 0) + 1, planet: newest }));
    bumpTitleBadge(gained);
    const tier = tierCrossed(before, live.referrals);
    notifyJoin(gained, position, tier);
    if (tier) celebrate(tier, live.referrals);
    if (document.visibilityState === "visible") burstFromPlanet(planetRef.current);
    else burstPending.current = true;
  }, [live.referrals, live.friendPlanets, position, token, celebrate]);

  // The burst for a join that landed in the background plays when the tab is shown again —
  // the tab-title badge promised it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (celebrationPending.current) {
        setCelebration(celebrationPending.current);
        celebrationPending.current = null;
      }
      if (!burstPending.current) return;
      burstPending.current = false;
      burstFromPlanet(planetRef.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const rise = (delay: number) =>
    full
      ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: DUR.base, ease: EASE_HOUSE, delay } }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <div className="grid sm:grid-cols-[168px_minmax(0,1fr)]">
      {celebration ? (
        <TierCelebration tier={celebration.tier} friends={celebration.friends} onDone={endCelebration} />
      ) : null}
      {/* Stub */}
      <div className="relative flex flex-col items-center px-4 pb-6 pt-5 text-center sm:pb-5">
        <motion.span
          ref={planetRef}
          data-pass-planet=""
          className="relative flex items-center justify-center"
          style={{ width: STUB_SIZE, height: STUB_SIZE }}
          initial={full ? { scale: 0.6, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={full ? { ...SPRING_SOFT, delay: 0.55 } : { duration: 0 }}
        >
          <PlanetArt planet={ticket.planet} size={PLANET_SIZE} />
        </motion.span>
        <p className="mt-3 font-[family-name:var(--font-display)] text-[28px] leading-none tracking-tight text-[#e8f3f1]">
          <span aria-hidden="true">#</span>
          <span className="sr-only">Place in line: </span>
          <RollingCount value={position} delay={full ? 0.35 : 0.1} />
        </p>
        <p className="mt-1.5 text-xs uppercase tracking-[0.14em] text-[#9aada8]">
          {live.referrals > 0 ? tier.label : planetLabel(ticket.planet)}
        </p>
      </div>

      {/* Seam: a plain dashed line, drawn with a scale transform (not `pathLength`, which
          overwrites `stroke-dasharray` every frame and renders the seam solid; and not a
          width/height animation, which fights a `sm:` `w-px`/`h-[calc(...)]` layout size
          set in the same className). A transform never touches layout, so the box keeps
          its final size throughout — only the dashes stretch slightly as they draw, and
          settle exact at scale 1. Horizontal on phones, vertical from sm. */}
      <motion.div
        aria-hidden="true"
        className="h-px w-full origin-left sm:hidden"
        initial={full ? { scaleX: 0 } : false}
        animate={{ scaleX: 1 }}
        transition={full ? { duration: DUR.slow, ease: EASE_HOUSE, delay: 0.1 } : { duration: 0 }}
      >
        <svg className="h-px w-full" viewBox="0 0 100 1" preserveAspectRatio="none">
          <line x1="0" y1="0.5" x2="100" y2="0.5" stroke="rgba(232,243,241,0.22)" strokeWidth="1" strokeDasharray="3 4" />
        </svg>
      </motion.div>

      {/* Details */}
      <div className="relative px-5 pb-5 pt-5 sm:pl-6">
        <motion.div
          aria-hidden="true"
          className="absolute left-0 top-4 hidden h-[calc(100%-2rem)] w-px origin-top sm:block"
          initial={full ? { scaleY: 0 } : false}
          animate={{ scaleY: 1 }}
          transition={full ? { duration: DUR.slow, ease: EASE_HOUSE, delay: 0.1 } : { duration: 0 }}
        >
          <svg className="h-full w-px" viewBox="0 0 1 100" preserveAspectRatio="none">
            <line x1="0.5" y1="0" x2="0.5" y2="100" stroke="rgba(232,243,241,0.22)" strokeWidth="1" strokeDasharray="3 4" />
          </svg>
        </motion.div>

        <motion.p {...rise(0.95)} className="text-xs uppercase tracking-[0.16em] text-[#9aada8]">
          Early access pass
        </motion.p>
        <motion.h3
          {...rise(1.0)}
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 font-[family-name:var(--font-display)] text-[22px] leading-[1.15] tracking-tight text-[#e8f3f1] outline-none"
        >
          {positionLine({ position })}
        </motion.h3>
        <motion.p {...rise(1.05)} className="mt-2 text-sm text-[#9aada8]">
          Joined {joinedLabel(ticket.joinedAt)} ·{" "}
          <span className="text-[#f2c14e]">
            {referralLine(live.referrals)}
          </span>
        </motion.p>

        {/* Always mounted, so screen readers hear each new line exactly once. */}
        <p aria-live="polite" className={news ? "mt-3" : undefined}>
          {news ? (
            <motion.span
              key={news.key}
              className="inline-flex items-start gap-2 rounded-xl border border-[#f2c14e]/25 bg-[#f2c14e]/[0.07] px-3 py-2 text-sm leading-snug text-[#e8f3f1]"
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE, delay: full ? 1.2 : 0 }}
            >
              {news.planet ? (
                <span className="-my-0.5 shrink-0">
                  <PlanetArt planet={news.planet} size={18} />
                </span>
              ) : (
                <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#f2c14e] shadow-[0_0_8px_rgba(242,193,78,0.8)]" />
              )}
              {news.text}
            </motion.span>
          ) : null}
        </p>

        <ShareRow
          ticket={ticket}
          pageUrl={pageUrl}
          play={full}
          onShared={() => {
            recordShare(token, live.referrals);
            const r = planetRef.current?.getBoundingClientRect();
            if (r && r.bottom > 0 && r.top < window.innerHeight) {
              threadStarfield(r.left + r.width / 2, r.top + r.height / 2);
            }
          }}
        />

        <NotifyOptIn />

        <motion.p {...rise(1.5)} className="mt-4 text-xs leading-[1.6] text-[#6d807c]">
          This is your pass. Your invite arrives by email when your wave opens.
        </motion.p>
      </div>
    </div>
  );
}

/** A starfield burst from the pass's planet — only if it is on screen to be seen. */
function burstFromPlanet(el: HTMLElement | null) {
  const r = el?.getBoundingClientRect();
  if (!r || r.bottom <= 0 || r.top >= window.innerHeight) return;
  pulseStarfield(r.left + r.width / 2, r.top + r.height / 2);
}

/**
 * "Tell me when a friend joins": the opt-in for system notifications (`join-notify.ts`).
 * Offered only where the browser can do it and the visitor hasn't decided; it goes away for
 * good once they answer. Says plainly that it only works while this page is open.
 */
function NotifyOptIn() {
  const [phase, setPhase] = useState<"hidden" | "offer" | "on">("hidden");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads client-only APIs
    if (shouldOfferNotify()) setPhase("offer");
  }, []);

  useEffect(() => {
    if (phase !== "on") return;
    const t = window.setTimeout(() => setPhase("hidden"), 3500);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === "hidden") return null;
  if (phase === "on") {
    return (
      <p role="status" className="mt-3 text-xs text-[#f2c14e]">
        We&apos;ll let you know while this page is open.
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={async () => {
        const answer = await requestNotify();
        setPhase(answer === "granted" ? "on" : "hidden");
      }}
      className="mt-3 inline-flex items-center gap-1.5 text-xs text-[#9aada8] underline-offset-4 transition-colors hover:text-[#e8f3f1] hover:underline"
    >
      <Bell className="size-3.5" aria-hidden="true" />
      Tell me when a friend joins
    </button>
  );
}
