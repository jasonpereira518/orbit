"use client";

import { Gift } from "lucide-react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { unwrapFeedbackThanks } from "@/actions/feedback";
import { CardStarfield } from "@/components/dashboard/card-starfield";
import { playDing } from "@/lib/ding";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import { useReducedMotionPreference } from "@/lib/use-prefers-reduced-motion";

/** Sparks in the burst. Enough to read as a burst, few enough to stay a flourish. */
const SPARKS = 14;
const SPARK_ANGLES = Array.from({ length: SPARKS }, (_, i) => (i / SPARKS) * Math.PI * 2);
/** Alternating spark colours, from the design language: gold for the gift, teal for Orbit. */
const SPARK_COLORS = ["var(--gold)", "var(--primary)"];

type Phase = "wrapped" | "opening" | "open";

/**
 * The credit thank-you, as a gift in the conversation.
 *
 * Wrapped until they tap it — the tap is the point: a gift you open is a moment, a line that
 * says you got one is a receipt. Opening squeezes and pops the card, lifts the ribbon, bursts
 * a ring of gold and teal sparks, plays the ding, and counts the credits up; then the new
 * balance and a way to spend them fade in. After that it stays as a quiet record.
 *
 * The unwrap is stamped on the server (`unwrapFeedbackThanks`) the moment they tap, and the
 * animation never waits for it — the balance line fills in when the answer arrives.
 *
 * Reduced motion: no sheen, sparks or bounce; the tap swaps to the opened card with one short
 * fade and the number shown in full. The ding still plays — it's sound, and has its own mute.
 */
export function ThanksGift({
  feedbackId,
  credits,
  seen,
  onNavigate,
}: {
  feedbackId: string;
  credits: number;
  /** Already unwrapped, on an earlier visit: render the quiet record, no ceremony. */
  seen: boolean;
  /** Called when they follow the "Try them in Chat" link — closes the feedback panel. */
  onNavigate?: () => void;
}) {
  const reduced = useReducedMotionPreference() ?? false;
  // Frozen at mount: the thread re-polls every few seconds and reports the gift as seen right
  // after this very card unwraps it, which must not turn the reveal into the quiet record.
  const [wasSeen] = useState(seen);
  const [phase, setPhase] = useState<Phase>(wasSeen ? "open" : "wrapped");
  const [balance, setBalance] = useState<number | null | undefined>(wasSeen ? null : undefined);
  /** Only an open that happens in front of them animates; a seen gift just sits there. */
  const [ceremony, setCeremony] = useState(false);

  const count = useMotionValue(wasSeen ? credits : 0);
  const shown = useTransform(count, (v) => Math.round(v));

  const open = () => {
    if (phase !== "wrapped") return;
    setCeremony(!reduced);
    playDing();
    if (reduced) {
      // No count-up and no bounce: straight to the opened card, which fades in.
      count.set(credits);
      setPhase("open");
    } else {
      setPhase("opening");
    }
    void unwrapFeedbackThanks(feedbackId)
      .then((result) => setBalance(result?.balance ?? null))
      .catch(() => setBalance(null));
  };

  // The count-up runs once the card has popped, and the reveal follows it.
  useEffect(() => {
    if (phase !== "opening") return;
    const controls = animate(count, credits, { duration: 0.7, ease: "easeOut", delay: 0.25 });
    const done = window.setTimeout(() => setPhase("open"), 950);
    return () => {
      controls.stop();
      window.clearTimeout(done);
    };
  }, [phase, credits, count]);

  if (phase === "wrapped") {
    return (
      <motion.button
        type="button"
        onClick={open}
        aria-label={`Open ${FEEDBACK_RECIPIENT}'s thank-you`}
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={reduced ? undefined : { y: -1 }}
        whileTap={reduced ? undefined : { scale: 0.97 }}
        className="relative max-w-[85%] overflow-hidden rounded-2xl bg-gradient-to-br from-gold via-gold/50 to-primary p-[1.5px] text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span className="relative flex items-center gap-3 overflow-hidden rounded-[calc(1rem-1.5px)] bg-[#03050c] px-4 py-3 text-[#e8f3f1]">
          <CardStarfield />
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f2c14e]/15">
            <Gift className="size-[1.1rem] text-[#f2c14e]" aria-hidden />
          </span>
          <span className="relative grid gap-0.5">
            <span className="text-sm font-medium">{FEEDBACK_RECIPIENT} sent you a thank-you</span>
            <span className="text-xs text-[#e8f3f1]/65">Tap to open</span>
          </span>
          {/* A slow sheen across the card, so it reads as something waiting to be opened. */}
          {!reduced && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-[#f2c14e]/25 to-transparent"
              animate={{ x: ["0%", "450%"] }}
              transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity, repeatDelay: 2.2 }}
            />
          )}
        </span>
      </motion.button>
    );
  }

  return (
    <motion.div
      className="relative max-w-[85%]"
      initial={ceremony ? { scale: 1 } : !wasSeen ? { opacity: 0 } : false}
      animate={ceremony ? { scale: [1, 0.96, 1.04, 1] } : { opacity: 1 }}
      transition={ceremony ? { duration: 0.45, times: [0, 0.3, 0.7, 1] } : { duration: 0.2 }}
    >
      {/* The burst: a ring of sparks from the card's centre, once. */}
      {ceremony && (
        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {SPARK_ANGLES.map((angle, i) => {
            const distance = 44 + (i % 3) * 16;
            return (
              <motion.span
                key={i}
                className="absolute size-1.5 rounded-full"
                style={{ background: SPARK_COLORS[i % 2] }}
                initial={{ x: 0, y: 0, opacity: 1, scale: 0.6 }}
                animate={{
                  x: Math.cos(angle) * distance,
                  y: Math.sin(angle) * distance,
                  opacity: 0,
                  scale: [0.6, 1.2, 0.4],
                }}
                transition={{ duration: 0.65, ease: "easeOut", delay: 0.12 }}
              />
            );
          })}
        </span>
      )}

      <div className="rounded-2xl bg-gradient-to-br from-gold via-gold/50 to-primary p-[1.5px] shadow-sm">
        {/* Deep space with drifting stars — the same night sky as the dashboard's network card. */}
        <div className="relative overflow-hidden rounded-[calc(1rem-1.5px)] bg-[#03050c] px-4 py-3 text-[#e8f3f1]">
          <CardStarfield />
          {/* The ribbon lifts off as it opens. */}
          {ceremony && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-2 bg-gradient-to-r from-gold to-gold/60"
              initial={{ y: 0, rotate: 0, opacity: 1 }}
              animate={{ y: -14, rotate: -6, opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeIn" }}
            />
          )}

          <div className="relative flex items-baseline gap-2">
            <span className="font-[family-name:var(--font-display)] text-3xl leading-none text-[#f2c14e] tabular-nums">
              +<motion.span>{shown}</motion.span>
            </span>
            <span className="text-sm font-medium">AI credits</span>
          </div>
          <p className="relative mt-1 text-xs text-[#e8f3f1]/65">
            A thank-you from {FEEDBACK_RECIPIENT} for your feedback
          </p>

          {/* What it means, then what to do with it — in sequence after the count lands. */}
          {!wasSeen && (
            <motion.p
              className="relative mt-3 text-sm"
              initial={{ opacity: 0, y: 4 }}
              animate={phase === "open" ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
              transition={{ duration: 0.25 }}
            >
              {balance === undefined ? (
                <span className="inline-block h-3.5 w-36 animate-pulse rounded bg-white/10 align-middle" />
              ) : balance === null ? null : (
                <>
                  Your balance: <span className="font-medium tabular-nums">{balance.toLocaleString()}</span> credits
                </>
              )}
            </motion.p>
          )}
          <motion.div
            className="relative"
            initial={wasSeen ? false : { opacity: 0, y: 4 }}
            animate={phase === "open" ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: 0.25, delay: wasSeen ? 0 : 0.12 }}
          >
            <Link
              href="/chat"
              onClick={onNavigate}
              className="mt-2 inline-block text-sm font-medium text-[#f2c14e] underline-offset-2 hover:underline"
            >
              Try them in Chat →
            </Link>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
