"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { Moons } from "@/components/interest/moons";
import { PlanetArt } from "@/components/interest/planet-art";
import { RollingCount } from "@/components/interest/proof-line";
import { ShareRow } from "@/components/interest/share-row";
import { formatTicketNumber, moonsLine, passengerLine, type InterestTicket } from "@/lib/interest-list";
import { DUR, EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { planetLabel } from "@/lib/welcome-planets";

const PLANET_SIZE = 96;
const RING_SIZE = 148;

function joinedLabel(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

/**
 * The ticket. A stub (planet, moons, number) and a details pane (passenger line, moons
 * line, share tools) with a perforated seam between them; the seam runs vertically from
 * `sm` up and horizontally on phones, where the stub stacks above the details.
 *
 * `entrance: "flip"` is the in-place reveal after a join: everything assembles in order
 * (seam draws, number rolls, planet springs in, moons drop, lines rise). `"direct"` is a
 * `?me=` visit: the ticket is fully in the HTML and only the number roll and the moon
 * drop play, once. Reduced motion: everything is simply there.
 */
export function BoardingPass({
  ticket,
  appUrl,
  signUpHref,
  entrance,
  headingRef,
}: {
  ticket: InterestTicket;
  appUrl: string;
  signUpHref: string;
  entrance: "flip" | "direct";
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const reduced = useReducedMotion();
  const full = entrance === "flip" && !reduced;

  const rise = (delay: number) =>
    full
      ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: DUR.base, ease: EASE_HOUSE, delay } }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <div className="grid sm:grid-cols-[168px_minmax(0,1fr)]">
      {/* Stub */}
      <div className="relative flex flex-col items-center px-4 pb-6 pt-5 text-center sm:pb-5">
        <motion.span
          className="relative flex items-center justify-center"
          style={{ width: RING_SIZE, height: RING_SIZE }}
          initial={full ? { scale: 0.6, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={full ? { ...SPRING_SOFT, delay: 0.55 } : { duration: 0 }}
        >
          <Moons count={ticket.moons} play={!reduced} size={RING_SIZE} />
          <PlanetArt planet={ticket.planet} size={PLANET_SIZE} />
        </motion.span>
        <p className="mt-3 font-[family-name:var(--font-display)] text-[28px] leading-none tracking-tight text-[#e8f3f1]">
          <span aria-hidden="true">#</span>
          <span className="sr-only">Number </span>
          <RollingCount value={ticket.number} delay={full ? 0.35 : 0.1} />
        </p>
        <p className="mt-1.5 text-xs uppercase tracking-[0.14em] text-[#9aada8]">{planetLabel(ticket.planet)}</p>
      </div>

      {/* Seam: an SVG line so it can draw itself. Horizontal on phones, vertical from sm. */}
      <svg aria-hidden="true" className="h-px w-full sm:hidden" viewBox="0 0 100 1" preserveAspectRatio="none">
        <motion.line x1="0" y1="0.5" x2="100" y2="0.5" stroke="rgba(232,243,241,0.22)" strokeWidth="1" strokeDasharray="3 4" initial={full ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={full ? { duration: DUR.slow, ease: EASE_HOUSE, delay: 0.1 } : { duration: 0 }} />
      </svg>

      {/* Details */}
      <div className="relative px-5 pb-5 pt-5 sm:pl-6">
        <svg aria-hidden="true" className="absolute left-0 top-4 hidden h-[calc(100%-2rem)] w-px sm:block" viewBox="0 0 1 100" preserveAspectRatio="none">
          <motion.line x1="0.5" y1="0" x2="0.5" y2="100" stroke="rgba(232,243,241,0.22)" strokeWidth="1" strokeDasharray="3 4" initial={full ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={full ? { duration: DUR.slow, ease: EASE_HOUSE, delay: 0.1 } : { duration: 0 }} />
        </svg>

        <motion.p {...rise(0.95)} className="text-xs uppercase tracking-[0.16em] text-[#9aada8]">
          Orbit · Interest list
        </motion.p>
        <motion.h3
          {...rise(1.0)}
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 font-[family-name:var(--font-display)] text-[22px] leading-[1.15] tracking-tight text-[#e8f3f1] outline-none"
        >
          Passenger {formatTicketNumber(ticket.number)}, bound for{" "}
          <em className="italic text-landing-accent">{planetLabel(ticket.planet)}</em>.
          <span className="sr-only">{passengerLine(ticket)}</span>
        </motion.h3>
        <motion.p {...rise(1.05)} className="mt-2 text-sm text-[#9aada8]">
          Joined {joinedLabel(ticket.joinedAt)} · {moonsLine(ticket.moons)}
        </motion.p>

        <ShareRow ticket={ticket} appUrl={appUrl} play={full} />

        <motion.p {...rise(1.5)} className="mt-4 text-xs leading-[1.6] text-[#6d807c]">
          Save this link — it&apos;s your page. Not one for waiting?{" "}
          <Link
            href={signUpHref}
            className="text-landing-accent underline decoration-[#f2c14e]/35 underline-offset-4 transition-colors hover:decoration-[#f2c14e]/90"
          >
            Orbit is live — start free
          </Link>
          .
        </motion.p>
      </div>
    </div>
  );
}
