"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { PlanetArt } from "@/components/interest/planet-art";
import { RollingCount } from "@/components/interest/proof-line";
import { ShareRow } from "@/components/interest/share-row";
import {
  describePassChange,
  liveJoinLine,
  positionLine,
  referralLine,
  tierFor,
  type InterestTicket,
} from "@/lib/interest-list";
import { usePassProgress } from "@/lib/interest-progress-store";
import { DUR, EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { readSeen, writeSeen } from "@/lib/pass-seen";
import { pulseStarfield } from "@/lib/starfield-events";
import { bumpTitleBadge } from "@/lib/tab-title-badge";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { planetLabel } from "@/lib/welcome-planets";

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
    () => ({ token: ticket.shareToken, referrals: ticket.referrals, position: ticket.position }),
    [ticket.shareToken, ticket.referrals, ticket.position]
  );
  const progress = usePassProgress(serverProgress);
  // Published progress can belong to a different pass (a second join on the same page).
  const live = progress.token === ticket.shareToken ? progress : serverProgress;
  const position = live.position ?? ticket.position;
  const { current: tier } = tierFor(live.referrals);
  const token = ticket.shareToken;

  const planetRef = useRef<HTMLSpanElement>(null);
  const [news, setNews] = useState<{ text: string; key: number } | null>(null);
  /** The referral count this pass last showed; null until the arrival read has run. */
  const shownReferrals = useRef<number | null>(null);
  /** A join that landed while the tab was hidden waits here for the tab to come back. */
  const burstPending = useRef(false);

  // Arrival: what changed since this device last showed this pass. localStorage only exists
  // after hydration, so this cannot be a lazy initial state.
  useEffect(() => {
    const now = { referrals: live.referrals, position };
    const seen = readSeen(token);
    const text = seen ? describePassChange(seen, now) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads client-only storage
    if (text) setNews({ text, key: 0 });
    writeSeen(token, now);
    shownReferrals.current = live.referrals;
    // Once per pass: live changes are the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live: a friend joined while the page is open.
  useEffect(() => {
    const before = shownReferrals.current;
    if (before === null) return;
    shownReferrals.current = live.referrals;
    writeSeen(token, { referrals: live.referrals, position });
    const gained = live.referrals - before;
    if (gained <= 0) return;
    setNews((prev) => ({ text: liveJoinLine(gained), key: (prev?.key ?? 0) + 1 }));
    bumpTitleBadge(gained);
    if (document.visibilityState === "visible") burstFromPlanet(planetRef.current);
    else burstPending.current = true;
  }, [live.referrals, position, token]);

  // The burst for a join that landed in the background plays when the tab is shown again —
  // the tab-title badge promised it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !burstPending.current) return;
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
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#f2c14e] shadow-[0_0_8px_rgba(242,193,78,0.8)]" />
              {news.text}
            </motion.span>
          ) : null}
        </p>

        <ShareRow ticket={ticket} pageUrl={pageUrl} play={full} />

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
