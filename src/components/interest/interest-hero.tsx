"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { joinInterestList, saveInterestListName } from "@/actions/interest-list";
import { BoardingPass } from "@/components/interest/boarding-pass";
import { PlanetArt } from "@/components/interest/planet-art";
import { ProofLine } from "@/components/interest/proof-line";
import {
  INTEREST_LIST_COUNT_FLOOR,
  NAME_MAX,
  buildTicketUrl,
  interestListSchema,
  type InterestTicket,
} from "@/lib/interest-list";
import type { InterestProof } from "@/lib/interest-list-ticket";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { pulseStarfield } from "@/lib/starfield-events";
import { announcePass } from "@/lib/waitlist-pass-events";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import type { WelcomePlanet } from "@/lib/welcome-planets";

export type HeroInitial =
  | { kind: "form"; proof: InterestProof; invite: WelcomePlanet | null; ref: string | null }
  | { kind: "ticket"; proof: InterestProof; ticket: InterestTicket };

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-4 text-base text-[#e8f3f1] transition-colors placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";

const buttonClass =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-landing-button-surface px-5 py-4 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

const GENERIC_ERROR = "Something went wrong — please try again.";
const FORMAT_ERROR = "That address doesn't look right.";

type Phase = "form" | "turning" | "ticket";

/** The form's two steps: the address first, then the name for the pass. */
type Step = "email" | "name";

const NAME_REQUIRED = "Please add your first and last name.";

/**
 * The hero: eyebrow, headline, sub-line and the card. The card is a three-state machine —
 * form (with an optional invited strip), turning (the flip's first half), ticket — and the
 * headline crossfades with it. The form itself has two steps: the address, then the name for
 * the pass.
 *
 * THE TWO STEPS. An address the list already knows (`result.returning`) skips step two and
 * goes straight to the pass. Step one calls `joinInterestList`, which is the join: the address is on the
 * list, the welcome mail is on its way and the ticket exists from that moment. The ticket
 * is held in state but not shown; step two saves the name against its share token and only
 * then turns the card. So someone who closes the tab on step two is still on the list.
 *
 * The flip: the card face rotates to 90° with the form on it (`turning`), the content
 * swaps, and a fresh face keyed on the ticket enters from −90°. Height follows via
 * `layout`. Reduced motion skips straight to the ticket, and a timeout finishes the turn
 * if `onAnimationComplete` never fires.
 *
 * `history.replaceState` runs only once the action has resolved and the ticket is in
 * state — a `replaceState` while a server action is queued drops the action (see the
 * memory of the same name).
 *
 * The success path never promises an email: `joinInterestList` answers `ok` with a ticket
 * for a duplicate, a rate-limited caller and a bot alike — by design — and the welcome
 * mail is best-effort on top of that.
 */
export function InterestHero({
  initial,
  pageUrl,
  pagePath,
}: {
  initial: HeroInitial;
  /** The waitlist page on its own domain, for the share link. */
  pageUrl: string;
  /** The path this page is served at — `/` on the waitlist host — for the pass's URL. */
  pagePath: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<Phase>(initial.kind === "ticket" ? "ticket" : "form");
  const [ticket, setTicket] = useState<InterestTicket | null>(
    initial.kind === "ticket" ? initial.ticket : null
  );
  const [entrance, setEntrance] = useState<"flip" | "direct">("direct");
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [rowScope, animateRow] = useAnimate();

  const invite = initial.kind === "form" ? initial.invite : null;
  const ref = initial.kind === "form" ? initial.ref : null;
  const showCount = initial.proof.count >= INTEREST_LIST_COUNT_FLOOR;

  // Set after mount, never during render: Date.now() on the server would not match the
  // client's and would trip hydration.
  const readyAt = useRef(0);
  useEffect(() => {
    readyAt.current = Date.now();
  }, []);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstNameRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Escape hatch for the flip's first half. `onAnimationComplete` is the primary path, but
  // it never fires while the tab is hidden (rAF is starved there), and the join would be
  // stranded on a card turned edge-on. The flip's own half is DUR.slow; 800 ms is past it
  // on any machine, so this only ever fires when the callback did not.
  useEffect(() => {
    if (phase !== "turning") return;
    const id = window.setTimeout(() => setPhase("ticket"), 800);
    return () => window.clearTimeout(id);
  }, [phase]);

  // The card has just changed under the person's hands: put the cursor where the next thing
  // goes, without scrolling the page.
  useEffect(() => {
    if (step === "name") firstNameRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Once the ticket is up after a join: make the URL its page, and hand focus to its
  // heading after the assembly so the browser's focus scroll does not fight the motion.
  useEffect(() => {
    if (phase !== "ticket" || entrance !== "flip" || !ticket) return;
    window.history.replaceState(window.history.state, "", buildTicketUrl(pagePath, ticket.shareToken));
    // The URL change does not re-render server components; tell the poll who this is.
    announcePass(ticket.shareToken);
    const id = window.setTimeout(
      () => headingRef.current?.focus({ preventScroll: true }),
      reduced ? 0 : 1600
    );
    return () => window.clearTimeout(id);
  }, [phase, entrance, ticket, reduced, pagePath]);

  function fail(message: string) {
    setError(message);
    if (!reduced) {
      animateRow(rowScope.current, { x: [0, -6, 5, -3, 0] }, { duration: 0.32 });
    }
  }

  function handleEmailSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const address = email.trim();

    // Same rule the server applies, checked here first so a typo does not cost a round
    // trip. The server re-validates regardless.
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
          ref: ref ?? undefined,
        });
        if (!result.ok) {
          fail(result.message);
          return;
        }
        setTicket(result.ticket);
        if (result.returning) {
          // Already on the list: nothing to ask, just show where they stand. Same reveal as
          // after the name step; measure the button while it is still on screen.
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) pulseStarfield(rect.left + rect.width / 2, rect.top + rect.height / 2);
          setEntrance("flip");
          setPhase(reduced ? "ticket" : "turning");
          return;
        }
        // A new address: held, not shown. The pass appears once the name is on it.
        setStep("name");
      } catch {
        fail(GENERIC_ERROR);
      }
    });
  }

  function handleNameSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const first = firstName.trim();
    const last = lastName.trim();
    if (!ticket) return;
    if (!first || !last) {
      fail(NAME_REQUIRED);
      return;
    }
    setError(null);

    startTransition(async () => {
      try {
        const result = await saveInterestListName({
          shareToken: ticket.shareToken,
          firstName: first,
          lastName: last,
        });
        if (!result.ok) {
          fail(result.message);
          return;
        }
        // Measure while the button is still on screen: the state change below unmounts
        // it. The canvas is viewport-fixed, so these coordinates land where it was.
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect) pulseStarfield(rect.left + rect.width / 2, rect.top + rect.height / 2);
        setEntrance("flip");
        setPhase(reduced ? "ticket" : "turning");
      } catch {
        fail(GENERIC_ERROR);
      }
    });
  }

  const showTicket = phase === "ticket" && ticket;
  const flipHalf = reduced ? { duration: 0 } : { duration: DUR.slow, ease: EASE_HOUSE };

  return (
    <>
      <section className="pt-10 text-center md:pt-16">
        <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
          Early access · Opening in waves
        </p>
        <h1 className={cn(HEADING, "mt-4 grid text-[clamp(34px,5.4vw,60px)]")}>
          {/* Both headlines occupy the same grid cell so the crossfade does not reflow. */}
          <AnimatePresence initial={false}>
            <motion.span
              key={showTicket ? "in" : "pitch"}
              className="col-start-1 row-start-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={flipHalf}
            >
              {/* Fraunces' true italic, declared in the root layout — the word that
                  carries the idea is the word that leans. */}
              {showTicket ? (
                <>You&apos;re <em className="italic">in line</em>.</>
              ) : (
                <>The future of <em className="italic">networking</em>.</>
              )}
            </motion.span>
          </AnimatePresence>
        </h1>
        <p className="mx-auto mt-5 max-w-[48ch] text-base leading-relaxed text-[#9aada8] sm:text-lg">
          {showTicket ? (
            <>
              Your place is saved. We&apos;re letting people in wave by wave — share your link
              to move up to the front.
            </>
          ) : (
            <>
              A central intelligence for everyone you know. We&apos;re letting people in wave by
              wave — join the waitlist and you&apos;ll be among the first.
            </>
          )}
        </p>
      </section>

      <section
        id="interest-join"
        aria-labelledby="interest-join-heading"
        className="relative mt-12 scroll-mt-24 md:mt-16"
      >
        <h2 id="interest-join-heading" className="sr-only">
          {showTicket ? "Your early access pass" : step === "name" ? "Add your name" : "Join the waitlist"}
        </h2>

        {/* Lives outside the swap so it exists before its text changes — a live region
            that mounts already populated is not announced. */}
        <p role="status" aria-live="polite" className="sr-only">
          {pending
            ? step === "name"
              ? "Getting your pass…"
              : "Joining the waitlist…"
            : showTicket
              ? "You're on the waitlist."
              : step === "name"
                ? "You're on the waitlist. One more step: add your name."
                : ""}
        </p>

        <div className="interest-flip-stage mx-auto max-w-xl">
          <motion.div
            layout
            transition={reduced ? { duration: 0 } : { layout: { duration: DUR.slow, ease: EASE_HOUSE } }}
            className={cn(
              "landing-glass relative rounded-3xl transition-shadow duration-300",
              !showTicket && "focus-within:shadow-[0_0_0_1px_rgba(242,193,78,0.22)]"
            )}
          >
            {showTicket ? (
              <motion.div
                key="ticket"
                className="interest-flip-face"
                initial={entrance === "flip" && !reduced ? { rotateY: -90 } : false}
                animate={{ rotateY: 0 }}
                transition={flipHalf}
              >
                <BoardingPass
                  ticket={ticket}
                  pageUrl={pageUrl}
                  entrance={entrance}
                  headingRef={headingRef}
                />
              </motion.div>
            ) : (
              <motion.form
                // Keyed on the step so the name step mounts fresh and fades in; the card's
                // `layout` carries the height change between them.
                key={`form-${step}`}
                className="interest-flip-face p-6 sm:p-8"
                noValidate
                onSubmit={step === "email" ? handleEmailSubmit : handleNameSubmit}
                initial={step === "name" && !reduced ? { opacity: 0, y: 6 } : false}
                animate={{ rotateY: phase === "turning" ? 90 : 0, opacity: 1, y: 0 }}
                transition={flipHalf}
                onAnimationComplete={() => {
                  if (phase === "turning") setPhase("ticket");
                }}
              >
                {step === "email" ? (
                  <>
                    {invite ? (
                      <p className="mb-4 flex items-center gap-2.5 rounded-xl border border-[#f2c14e]/25 bg-[#f2c14e]/[0.06] px-3.5 py-2.5 text-sm text-[#e8f3f1]">
                        <PlanetArt planet={invite} size={22} />
                        <span>
                          A friend saved you a seat. Join and you&apos;ll help them reach the front
                          wave.
                        </span>
                      </p>
                    ) : null}

                    <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
                      Join the waitlist
                    </p>
                    <p className="mt-2 text-lg text-[#e8f3f1]">
                      We&apos;ll only email you about your place in line.
                    </p>

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
                        disabled={pending || phase === "turning"}
                        aria-busy={pending}
                        className={buttonClass}
                      >
                        {pending ? <Pending reduced={reduced}>Joining…</Pending> : "Join the waitlist"}
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
                  </>
                ) : (
                  <>
                    <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
                      You&apos;re on the list
                    </p>
                    <p className="mt-2 text-lg text-[#e8f3f1]">
                      One more thing — whose name goes on your pass?
                    </p>

                    <div ref={rowScope} className="mt-5 grid gap-3 sm:grid-cols-2">
                      <label htmlFor="interest-first-name" className="sr-only">
                        First name
                      </label>
                      <input
                        ref={firstNameRef}
                        id="interest-first-name"
                        type="text"
                        name="firstName"
                        autoComplete="given-name"
                        maxLength={NAME_MAX}
                        required
                        placeholder="First name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? "interest-error" : undefined}
                        className={cn(inputClass, error && "border-[#e8a84e]/60")}
                      />
                      <label htmlFor="interest-last-name" className="sr-only">
                        Last name
                      </label>
                      <input
                        id="interest-last-name"
                        type="text"
                        name="lastName"
                        autoComplete="family-name"
                        maxLength={NAME_MAX}
                        required
                        placeholder="Last name"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? "interest-error" : undefined}
                        className={cn(inputClass, error && "border-[#e8a84e]/60")}
                      />
                    </div>
                    <button
                      ref={buttonRef}
                      type="submit"
                      disabled={pending || phase === "turning"}
                      aria-busy={pending}
                      className={cn(buttonClass, "mt-3 w-full")}
                    >
                      {pending ? <Pending reduced={reduced}>Getting your pass…</Pending> : "Get my pass"}
                    </button>
                  </>
                )}

                {error ? (
                  <p id="interest-error" role="alert" className="mt-3 text-sm text-[#e8a84e]">
                    {error}
                  </p>
                ) : step === "email" ? (
                  <ProofLine proof={initial.proof} showCount={showCount} />
                ) : null}
              </motion.form>
            )}
          </motion.div>
        </div>
      </section>
    </>
  );
}

/** One dot circling a faint ring, not a spinner. */
function Pending({ reduced, children }: { reduced: boolean; children: React.ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className="relative inline-block size-4">
        <span className="absolute inset-0 rounded-full border border-current/30" />
        <span
          className={cn("absolute inset-0", !reduced && "animate-[interest-spin_0.9s_linear_infinite]")}
        >
          <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
        </span>
      </span>
      {children}
    </>
  );
}
