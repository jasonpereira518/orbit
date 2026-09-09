"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  AnimatePresence,
  motion,
  useAnimate,
  useReducedMotion,
} from "motion/react";
import { joinInterestList } from "@/actions/interest-list";
import { interestListSchema } from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { pulseStarfield } from "@/lib/starfield-events";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-4 text-base text-[#e8f3f1] transition-colors placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";

const buttonClass =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-landing-button-surface px-5 py-4 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

const GENERIC_ERROR = "Something went wrong — please try again.";
const FORMAT_ERROR = "That address doesn't look right.";

/**
 * The /interest page's form. Same action, honeypot and fill-time trap as the landing
 * page's `WaitlistForm` — this is the hero-sized version with the choreography:
 * an orbiting loader while the join is in flight, and on success the form gives way
 * to a lockup while the starfield fires a pulse from where the button was
 * (`lib/starfield-events.ts`).
 *
 * The success copy never promises an email. `joinInterestList` answers `ok` for a
 * duplicate address, a rate-limited one and a bot alike — by design, so nothing can
 * be probed from outside — and the welcome mail is best-effort on top of that.
 */
export function InterestForm({
  /** Where "try it now" goes: /sign-up with Clerk, /dashboard in demo mode. */
  signUpHref,
}: {
  signUpHref: string;
}) {
  const reduced = useReducedMotion();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const [rowScope, animateRow] = useAnimate();

  // Set after mount, never during render: Date.now() on the server would not match
  // the client's and would trip hydration.
  const readyAt = useRef(0);
  useEffect(() => {
    readyAt.current = Date.now();
  }, []);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The submit button unmounts on success, which would drop focus to <body>. Hand it
  // to the heading instead — after the lockup has risen, so the browser's focus
  // scroll does not fight the enter animation.
  useEffect(() => {
    if (!sent) return;
    const id = window.setTimeout(
      () => headingRef.current?.focus({ preventScroll: true }),
      reduced ? 0 : 420
    );
    return () => window.clearTimeout(id);
  }, [sent, reduced]);

  function fail(message: string) {
    setError(message);
    if (!reduced) {
      animateRow(rowScope.current, { x: [0, -6, 5, -3, 0] }, { duration: 0.32 });
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const address = email.trim();

    // Same rule the server applies, checked here first so a typo does not cost a
    // round trip. The server re-validates regardless.
    if (!interestListSchema.shape.email.safeParse(address).success) {
      fail(FORMAT_ERROR);
      return;
    }
    setError(null);

    startTransition(async () => {
      try {
        const result = await joinInterestList({
          email: address,
          website: String(data.get("website") ?? ""),
          elapsedMs: readyAt.current ? Date.now() - readyAt.current : 0,
        });
        if (!result.ok) {
          fail(result.message);
          return;
        }
        // Measure while the button is still on screen: the state change below
        // unmounts it. The canvas is viewport-fixed, so these coordinates land
        // exactly where the button was.
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect) pulseStarfield(rect.left + rect.width / 2, rect.top + rect.height / 2);
        setSent(true);
      } catch {
        fail(GENERIC_ERROR);
      }
    });
  }

  const enter = reduced
    ? { duration: 0 }
    : { duration: DUR.celestial, ease: EASE_HOUSE, delay: 0.05 };
  const exit = reduced ? { duration: 0 } : { duration: DUR.slow, ease: EASE_HOUSE };

  return (
    <div
      className={cn(
        "landing-glass relative min-h-[248px] rounded-3xl p-6 transition-shadow duration-300 sm:p-8",
        !sent && "focus-within:shadow-[0_0_0_1px_rgba(242,193,78,0.22)]"
      )}
    >
      {/* Lives outside the swap so it exists before its text changes — a live region
          that mounts already populated is not announced. */}
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Joining the list…" : sent ? "You're on the list." : ""}
      </p>

      <AnimatePresence mode="wait" initial={false}>
        {sent ? (
          <motion.div
            key="done"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={enter}
            className="flex flex-col items-center text-center"
          >
            <span className="relative flex size-12 items-center justify-center">
              {/* The in-card echo of the canvas burst: one ring expanding out of the mark. */}
              <motion.span
                aria-hidden="true"
                className="absolute inset-0 rounded-full border border-[#f2c14e]/60"
                initial={{ scale: 0.6, opacity: 0.5 }}
                animate={{ scale: 1.6, opacity: 0 }}
                transition={reduced ? { duration: 0 } : { duration: 0.9, ease: "easeOut", delay: 0.1 }}
              />
              <svg viewBox="0 0 48 48" className="size-12" aria-hidden="true">
                <motion.circle
                  cx={24}
                  cy={24}
                  r={22}
                  fill="none"
                  stroke="rgba(242, 193, 78, 0.6)"
                  strokeWidth={1.5}
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={reduced ? { duration: 0 } : { duration: 0.8, delay: 0.15, ease: EASE_HOUSE }}
                />
                <motion.path
                  d="M15 24.5l6.5 6.5L33 18"
                  fill="none"
                  stroke="#f2c14e"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={reduced ? { duration: 0 } : { duration: 0.45, delay: 0.6, ease: EASE_HOUSE }}
                />
              </svg>
            </span>
            <h3
              ref={headingRef}
              tabIndex={-1}
              className="mt-5 font-[family-name:var(--font-display)] text-2xl tracking-tight text-[#e8f3f1] outline-none"
            >
              You&apos;re on the list.
            </h3>
            <p className="mx-auto mt-2 max-w-[36ch] text-sm leading-[1.65] text-[#9aada8]">
              You&apos;ll hear from Jason when there&apos;s something real to say —
              and not otherwise.
            </p>
            <p className="mt-6 text-sm text-[#6d807c]">
              Not one for waiting?{" "}
              <Link
                href={signUpHref}
                className="text-landing-accent underline decoration-[#f2c14e]/35 underline-offset-4 transition-colors hover:decoration-[#f2c14e]/90"
              >
                Orbit is live — start free
              </Link>
              .
            </p>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            noValidate
            onSubmit={handleSubmit}
            exit={{ opacity: 0, y: -8 }}
            transition={exit}
          >
            <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
              Join the list
            </p>
            <p className="mt-2 text-lg text-[#e8f3f1]">One address. Occasional news.</p>

            <div ref={rowScope} className="mt-5 flex flex-col gap-3 sm:flex-row">
              <label htmlFor="interest-email" className="sr-only">
                Email address
              </label>
              <input
                id="interest-email"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                maxLength={160}
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "interest-error" : undefined}
                className={cn(inputClass, error && "border-[#e8a84e]/60")}
              />
              <button
                ref={buttonRef}
                type="submit"
                disabled={pending}
                aria-busy={pending}
                className={buttonClass}
              >
                {pending ? (
                  <>
                    {/* An orbit, not a spinner: one dot circling a faint ring. */}
                    <span aria-hidden="true" className="relative inline-block size-4">
                      <span className="absolute inset-0 rounded-full border border-current/30" />
                      <span
                        className={cn(
                          "absolute inset-0",
                          !reduced && "animate-[interest-orbit_0.9s_linear_infinite]"
                        )}
                      >
                        <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
                      </span>
                    </span>
                    Joining…
                  </>
                ) : (
                  "Join the list"
                )}
              </button>
            </div>

            {/* Honeypot. Off-screen rather than display:none — some bots skip hidden
                fields but happily fill one that is merely positioned away. */}
            <div
              aria-hidden="true"
              className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden"
            >
              <label htmlFor="interest-website">Website</label>
              <input id="interest-website" name="website" tabIndex={-1} autoComplete="off" />
            </div>

            {error ? (
              <p id="interest-error" role="alert" className="mt-3 text-sm text-[#e8a84e]">
                {error}
              </p>
            ) : (
              <p className="mt-3 text-xs leading-[1.6] text-[#6d807c]">
                No confirmation step. A one-click unsubscribe in every note.
              </p>
            )}
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
