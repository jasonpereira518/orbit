"use client";

import { useId, useMemo, useState } from "react";
import { PlanetArt } from "@/components/interest/planet-art";
import { TierArt } from "@/components/interest/tier-art";
import { SPOTS_PER_REFERRAL, formatTicketNumber } from "@/lib/interest-list";
import { usePassProgress, type PassProgress } from "@/lib/interest-progress-store";
import { cn } from "@/lib/utils";
import type { WelcomePlanet } from "@/lib/welcome-planets";

/*
 * The curve, in a 300 × 48 box stretched to the band's width: a quadratic from (0, 44) to
 * (300, 44) with its control at (150, -20). x runs linearly with t, so the four column
 * centres (x = 37.5, 112.5, 187.5, 262.5) sit at t = 1/8, 3/8, 5/8, 7/8, where the curve is
 * at y = 30, 14, 14, 30. The stops are placed at exactly those heights, so they ride the
 * line at every width.
 */
const ARC = "M 0 44 Q 150 -20 300 44";
const STOP_T = [1 / 8, 3 / 8, 5 / 8, 7 / 8];
const STOP_Y = [30, 14, 14, 30];
const BAND_H = 48;

/** The arc from its start to parameter t, as its own quadratic (de Casteljau): the gold
 * "covered" stretch, which then hugs the dashed arc exactly at every width. */
function arcTo(t: number) {
  const cx = 150 * t;
  const cy = 44 - 64 * t;
  const u = 2 * t * (1 - t);
  const ex = 300 * t;
  const ey = 44 * (1 - u) - 20 * u;
  return `M 0 44 Q ${cx} ${cy} ${ex} ${ey}`;
}

type Stop = { title: string; body: string };

const STOPS: readonly Stop[] = [
  { title: "Join the waitlist", body: "One email address holds your place." },
  {
    title: "Bring friends",
    body: `Each friend who joins through your link moves you up ${SPOTS_PER_REFERRAL} spots.`,
  },
  { title: "Your wave opens", body: "We open a few spots at a time, in line order. The nearer the front, the sooner your wave." },
  { title: "Your invite arrives", body: "It lands in your inbox. That's when you're in." },
];

/** The section's heading follows the pass too: a visitor with one is on their way in. */
export function JourneyTitle({ token, className }: { token: string | null; className?: string }) {
  const serverInitial = useMemo<PassProgress>(() => ({ token, referrals: 0, position: null }), [token]);
  const live = usePassProgress(serverInitial);
  return (
    <h2 id="waitlist-how" className={className}>
      {live.token ? "Your way in." : "How early access works."}
    </h2>
  );
}

/**
 * "How early access works" as the visitor's own journey: four stops on one arc — join, bring
 * friends, your wave opens, your invite arrives (the sun, the destination).
 *
 * PERSONAL. It reads the live pass (`usePassProgress`), so it moves the moment a friend joins.
 * No pass: stop one pulses "Start here". A pass: the visitor's own planet sits on the path as
 * "You're here · #N" — at stop one, or at "Bring friends" once a friend has joined — and the
 * stretch behind it is gold. It never claims to know their wave: stops three and four stay
 * ahead until an invite really exists.
 *
 * INTERACTIVE. Each stop is a button; hover, tap or focus opens its detail (on desktop one
 * panel under the arc, on phones inline under the stop, on a vertical path). The stop that
 * matters now is open by default.
 *
 * The arc draws itself once when revealed (CSS keyed off `<Reveal>`'s `data-reveal="in"`),
 * then the gold stretch, then the marker drops on. The "Start here" pulse plays three times.
 * Reduced motion: everything is simply there.
 */
export function EarlyAccessPath({
  token,
  referrals,
  position,
  planet,
  joinHref,
  tiersHref,
}: {
  token: string | null;
  referrals: number;
  position: number | null;
  planet: WelcomePlanet | null;
  /** The hero's card: the form, or the pass with its share link. */
  joinHref: string;
  /** The referral tracker. */
  tiersHref: string;
}) {
  const serverInitial = useMemo<PassProgress>(
    () => ({ token, referrals, position }),
    [token, referrals, position]
  );
  const live = usePassProgress(serverInitial);
  const hasPass = Boolean(live.token);
  const friends = live.referrals;
  /** The stop the visitor is at: -1 before joining, 0 joined, 1 once friends have joined. */
  const here = !hasPass ? -1 : friends > 0 ? 1 : 0;
  const [open, setOpen] = useState(() => (here >= 0 ? 1 : 0));
  const baseId = useId();

  const detail = (i: number) => (
    <StopDetail
      index={i}
      hasPass={hasPass}
      friends={friends}
      position={live.position}
      joinHref={joinHref}
      tiersHref={tiersHref}
    />
  );

  return (
    <div className="early-path relative md:pt-12">
      <svg
        aria-hidden="true"
        viewBox={`0 0 300 ${BAND_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 top-12 hidden w-full md:block"
        style={{ height: BAND_H }}
      >
        <path
          d={ARC}
          pathLength={1}
          fill="none"
          stroke="rgba(122, 168, 150, 0.35)"
          strokeWidth={1}
          className="early-path-draw"
        />
        <path
          d={ARC}
          fill="none"
          stroke="rgba(242, 193, 78, 0.35)"
          strokeWidth={1}
          strokeDasharray="2 7"
          vectorEffect="non-scaling-stroke"
          className="early-path-cadence"
        />
        {here >= 0 ? (
          <path
            d={arcTo(STOP_T[here]!)}
            pathLength={1}
            fill="none"
            stroke="#f2c14e"
            strokeWidth={2}
            // No non-scaling stroke here: it moves the dash pattern into screen pixels, and
            // the pathLength draw-in (a single dash of length 1) then breaks into gaps.
            className="early-path-covered"
            style={{ filter: "drop-shadow(0 0 4px rgba(242,193,78,0.7))" }}
          />
        ) : null}
      </svg>

      <ol className="ml-2 grid gap-2 md:ml-0 md:grid-cols-4 md:gap-0">
        {STOPS.map((stop, i) => {
          const last = i === STOPS.length - 1;
          const done = i <= here;
          const isHere = i === here;
          const start = here < 0 && i === 0;
          const isOpen = open === i;
          return (
            <li
              key={stop.title}
              aria-current={isHere ? "step" : undefined}
              className="relative pl-9 md:px-3 md:pl-3 md:text-center"
            >
              {/* Phones: this stop's stretch of the vertical path, gold once walked. */}
              {!last ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-[11px] top-7 bottom-[-12px] w-0 border-l md:hidden",
                    i < here ? "border-solid border-[#f2c14e] shadow-[0_0_6px_rgba(242,193,78,0.6)]" : "border-dashed border-[#e8f3f1]/20"
                  )}
                />
              ) : null}

              {/* The stop: on the arc from md, on the left-hand line below it. */}
              <span
                aria-hidden="true"
                className="absolute left-0 top-1 flex size-6 items-center justify-center md:relative md:left-auto md:top-auto md:mx-auto md:block md:h-12 md:w-full"
              >
                <span
                  className="flex items-center justify-center md:absolute md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2"
                  style={{ top: STOP_Y[i] }}
                >
                  {isHere && planet ? (
                    <span className="early-path-marker relative flex items-center justify-center rounded-full ring-2 ring-[#f2c14e] shadow-[0_0_14px_rgba(242,193,78,0.7)]">
                      <PlanetArt planet={planet} size={24} />
                    </span>
                  ) : last ? (
                    <span className="early-path-stop block" style={{ animationDelay: "1.25s" }}>
                      <TierArt tierId="founding" size={44} />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "early-path-stop relative block size-4 rounded-full",
                        done
                          ? "bg-[#f2c14e] shadow-[0_0_14px_rgba(242,193,78,0.8)]"
                          : "border border-[#f2c14e]/60 bg-[#0b1120] shadow-[0_0_10px_rgba(242,193,78,0.25)]"
                      )}
                      style={{ animationDelay: `${0.35 + i * 0.3}s` }}
                    >
                      {start ? <span className="early-path-start absolute inset-0 rounded-full border border-[#f2c14e]" /> : null}
                    </span>
                  )}
                  {isHere ? (
                    <span className="early-path-marker absolute bottom-full mb-2 hidden whitespace-nowrap rounded-full border border-[#f2c14e]/40 bg-[#0b1120]/95 px-2.5 py-1 text-[11px] font-medium text-[#f2c14e] md:block">
                      You&apos;re here{live.position ? ` · #${formatTicketNumber(live.position)}` : ""}
                    </span>
                  ) : start ? (
                    <span className="absolute bottom-full mb-2 hidden whitespace-nowrap rounded-full border border-[#f2c14e]/40 bg-[#0b1120]/95 px-2.5 py-1 text-[11px] font-medium text-[#f2c14e] md:block">
                      Start here
                    </span>
                  ) : null}
                </span>
              </span>

              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`${baseId}-detail`}
                onClick={() => setOpen(i)}
                onFocus={() => setOpen(i)}
                onMouseEnter={() => setOpen(i)}
                className={cn(
                  "group w-full rounded-xl px-2 py-2 text-left transition-colors md:mt-3 md:text-center",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60",
                  isOpen ? "bg-[#e8f3f1]/[0.04]" : "hover:bg-[#e8f3f1]/[0.03]"
                )}
              >
                <span className={cn("block font-[family-name:var(--font-display)] text-2xl leading-none", done || isOpen ? "text-landing-accent" : "text-[#f2c14e]/55")}>
                  {i + 1}
                </span>
                <span className={cn("mt-2 block text-sm font-medium", isOpen || done ? "text-[#e8f3f1]" : "text-[#e8f3f1]/75")}>
                  {stop.title}
                  {isHere ? <span className="ml-1.5 text-xs font-normal text-[#f2c14e] md:hidden">· You&apos;re here</span> : null}
                </span>
              </button>

              {/* Phones: the detail opens under its own stop. */}
              {isOpen ? <div className="px-2 pb-3 md:hidden">{detail(i)}</div> : null}
            </li>
          );
        })}
      </ol>

      {/* Desktop: one panel under the arc, following the open stop. */}
      <div
        id={`${baseId}-detail`}
        aria-live="polite"
        className="mx-auto mt-4 hidden min-h-[92px] max-w-[46ch] text-center md:block"
      >
        {detail(open)}
      </div>
    </div>
  );
}

function StopDetail({
  index,
  hasPass,
  friends,
  position,
  joinHref,
  tiersHref,
}: {
  index: number;
  hasPass: boolean;
  friends: number;
  position: number | null;
  joinHref: string;
  tiersHref: string;
}) {
  const link =
    "inline-flex items-center rounded-full border border-[#f2c14e]/40 px-3 py-1.5 text-xs text-[#f2c14e] transition-colors hover:border-[#f2c14e] hover:bg-[#f2c14e]/10";
  const stop = STOPS[index]!;
  return (
    <div key={index} className="early-path-detail">
      <p className="text-sm leading-relaxed text-[#9aada8]">{stop.body}</p>
      {index === 0 ? (
        hasPass ? (
          <p className="mt-2 text-sm text-[#e8f3f1]">
            Your place is saved{position ? ` — you're #${formatTicketNumber(position)}` : ""}.
          </p>
        ) : (
          <div className="mt-3 flex justify-start md:justify-center">
            <a href={joinHref} className={link}>
              Join the waitlist
            </a>
          </div>
        )
      ) : null}
      {index === 1 ? (
        hasPass ? (
          <>
            <p className="mt-2 text-sm text-[#e8f3f1]">
              {friends === 0
                ? "No friends yet — your first one moves you up right away."
                : `${friends === 1 ? "1 friend" : `${friends} friends`} so far · +${friends * SPOTS_PER_REFERRAL} spots`}
            </p>
            <div className="mt-3 flex flex-wrap justify-start gap-2 md:justify-center">
              <a href={joinHref} className={link}>
                Share your link
              </a>
              <a href={tiersHref} className={link}>
                See what friends unlock ↓
              </a>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-[#e8f3f1]/80">Join first to get your link.</p>
        )
      ) : null}
    </div>
  );
}
