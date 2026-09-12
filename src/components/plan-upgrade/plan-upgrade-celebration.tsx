"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  Infinity as InfinityIcon,
  Layers3,
  RefreshCwOff,
  UserRoundSearch,
  UsersRound,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { OrbitLogo } from "@/components/orbit-logo";
import type { PlanUpgradeEvent } from "@/lib/plan-upgrade-events";
import { EASE_HOUSE } from "@/lib/motion";

type Phase = "reveal" | "ready" | "brand" | "flight" | "exit";
type Destination = { x: number; y: number; scale: number };
type LogoPresentation = {
  plan: "orbit" | "lifetime";
  hidden: boolean;
};

const PRO_BENEFITS = [
  { label: "Unlimited contacts", Icon: UsersRound },
  { label: "Recruiter tracking", Icon: UserRoundSearch },
  { label: "Inbox + calendar sync", Icon: CalendarDays },
] as const;

const LIFETIME_BENEFITS = [
  { label: "Unlimited contacts", Icon: InfinityIcon },
  { label: "Every core feature", Icon: Layers3 },
  { label: "No subscription", Icon: RefreshCwOff },
] as const;

const STAR_POINTS = Array.from({ length: 42 }, (_, index) => ({
  left: `${(index * 37 + 11) % 97}%`,
  top: `${(index * 61 + 7) % 91}%`,
  size: index % 9 === 0 ? 3 : index % 4 === 0 ? 2 : 1,
  opacity: 0.18 + (index % 5) * 0.07,
  delay: (index % 8) * 0.16,
}));

function SpaceAtmosphere({
  lifetime,
  phase,
  reduced,
}: {
  lifetime: boolean;
  phase: Phase;
  reduced: boolean;
}) {
  const visible = phase !== "exit";
  const ink = lifetime ? "rgba(50, 35, 2, 0.26)" : "rgba(255, 255, 255, 0.24)";
  const bright = lifetime ? "rgba(74, 50, 0, 0.52)" : "rgba(255, 255, 255, 0.72)";

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.45 }}
    >
      <div
        className="absolute inset-0"
        style={{
          background: lifetime
            ? "radial-gradient(ellipse 62% 68% at 82% 38%, rgba(255,239,178,0.16), transparent 70%), radial-gradient(ellipse 52% 58% at 7% 92%, rgba(105,65,0,0.18), transparent 74%)"
            : "radial-gradient(ellipse 68% 76% at 76% 28%, rgba(24,78,174,0.34), transparent 72%), radial-gradient(ellipse 54% 60% at 10% 92%, rgba(222,239,255,0.16), transparent 74%)",
        }}
      />

      {STAR_POINTS.map((star, index) => (
        <motion.span
          key={index}
          className="absolute rounded-full"
          style={{
            left: star.left,
            top: star.top,
            width: star.size,
            height: star.size,
            backgroundColor: index % 7 === 0 ? bright : ink,
            boxShadow:
              index % 9 === 0 ? `0 0 10px 2px ${ink}` : "none",
          }}
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{
            opacity: visible
              ? reduced
                ? star.opacity
                : [star.opacity * 0.65, star.opacity, star.opacity * 0.72]
              : 0,
            scale: visible ? (reduced ? 1 : [0.9, 1.12, 0.96]) : 0.7,
          }}
          transition={{
            opacity: {
              duration: 2.8 + (index % 4) * 0.55,
              delay: star.delay,
              repeat: Infinity,
              repeatType: "mirror",
            },
            scale: {
              duration: 3.2 + (index % 3) * 0.7,
              delay: star.delay,
              repeat: Infinity,
              repeatType: "mirror",
            },
          }}
        />
      ))}

      <motion.svg
        className={
          lifetime
            ? "absolute -right-[10vw] top-[7vh] h-[76vh] w-[64vw] overflow-visible"
            : "absolute right-[1vw] top-[12vh] h-[68vh] w-[48vw] overflow-visible"
        }
        viewBox="0 0 900 700"
        fill="none"
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: visible ? 1 : 0, scale: visible ? 1 : 0.97 }}
        transition={{ duration: 1.1, delay: 0.2, ease: EASE_HOUSE }}
      >
        <defs>
          <radialGradient id="pro-core" cx="42%" cy="34%" r="70%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.32)" />
            <stop offset="58%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="100%" stopColor="rgba(18,73,145,0.18)" />
          </radialGradient>
          <linearGradient id="pro-orbit" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
            <stop offset="48%" stopColor="rgba(255,255,255,0.68)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.08)" />
          </linearGradient>
        </defs>

        {lifetime ? (
          <>
            <motion.path
              d="M146 250 L267 292 L373 280 L470 320 L521 431 L644 457 L666 337 L470 320"
              stroke={ink}
              strokeWidth="2.25"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: visible ? 1 : 0, opacity: visible ? 0.8 : 0 }}
              transition={{ duration: 1.45, delay: 0.42, ease: EASE_HOUSE }}
            />
            <motion.path
              d="M146 250 L267 292 L373 280 L470 320 L521 431 L644 457 L666 337 L470 320"
              stroke="rgba(255,255,255,0.88)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="20 260"
              initial={{ opacity: 0, strokeDashoffset: 280 }}
              animate={{
                opacity: visible && !reduced ? [0, 0.9, 0] : 0,
                strokeDashoffset: visible ? -280 : 280,
              }}
              transition={{
                duration: 3.6,
                delay: 1.25,
                repeat: reduced ? 0 : Infinity,
                repeatDelay: 0.8,
                ease: "linear",
              }}
            />
            {[
              [146, 250],
              [267, 292],
              [373, 280],
              [470, 320],
              [521, 431],
              [644, 457],
              [666, 337],
            ].map(([cx, cy], index) => (
              <motion.g
                key={`${cx}-${cy}`}
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: visible ? 1 : 0, scale: visible ? 1 : 0 }}
                transition={{ duration: 0.42, delay: 0.72 + index * 0.1 }}
                style={{ transformOrigin: `${cx}px ${cy}px` }}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={index === 6 ? 7 : index === 0 ? 5.5 : 4.5}
                  fill={bright}
                  style={{ filter: `drop-shadow(0 0 8px ${bright})` }}
                />
                {(index === 0 || index === 3 || index === 6) && (
                  <motion.path
                    d={`M${cx - 16} ${cy} H${cx + 16} M${cx} ${cy - 16} V${cy + 16}`}
                    stroke="rgba(255,255,255,0.82)"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    animate={
                      reduced
                        ? { opacity: 0.45 }
                        : { opacity: [0.12, 0.9, 0.12], scale: [0.72, 1.12, 0.72] }
                    }
                    transition={{
                      duration: 2.8,
                      delay: 1.1 + index * 0.14,
                      repeat: reduced ? 0 : Infinity,
                      ease: EASE_HOUSE,
                    }}
                    style={{ transformOrigin: `${cx}px ${cy}px` }}
                  />
                )}
              </motion.g>
            ))}
          </>
        ) : (
          <>
            <circle cx="510" cy="352" r="124" fill="url(#pro-core)" />
            <circle
              cx="510"
              cy="352"
              r="124"
              stroke="rgba(255,255,255,0.48)"
              strokeWidth="1.5"
            />
            {[
              [510, 352, 288, 162, -13],
              [510, 352, 358, 218, 16],
              [510, 352, 420, 268, -7],
            ].map(([cx, cy, rx, ry, rotate], index) => (
              <motion.ellipse
                key={rx}
                cx={cx}
                cy={cy}
                rx={rx}
                ry={ry}
                stroke="url(#pro-orbit)"
                strokeWidth={index === 0 ? "1.8" : "1.1"}
                transform={`rotate(${rotate} ${cx} ${cy})`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: visible ? 1 : 0, opacity: visible ? 1 : 0 }}
                transition={{ duration: 1.15 + index * 0.18, delay: 0.28, ease: EASE_HOUSE }}
              />
            ))}
            <motion.path
              d="M435 389 L475 314 L536 337 L582 293 M475 314 L507 405 L565 383 L536 337"
              stroke="rgba(255,255,255,0.58)"
              strokeWidth="1.5"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: visible ? 1 : 0, opacity: visible ? 1 : 0 }}
              transition={{ duration: 1.2, delay: 0.68, ease: EASE_HOUSE }}
            />
            {[
              [435, 389, 5],
              [475, 314, 7],
              [507, 405, 5],
              [536, 337, 8],
              [565, 383, 5],
              [582, 293, 6],
              [246, 268, 6],
              [756, 282, 7],
              [720, 507, 5],
            ].map(([cx, cy, radius], index) => (
              <motion.circle
                key={`${cx}-${cy}`}
                cx={cx}
                cy={cy}
                r={radius}
                fill={index < 6 ? "rgba(255,255,255,0.9)" : "rgba(225,241,255,0.72)"}
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: visible ? 1 : 0, scale: visible ? 1 : 0 }}
                transition={{ duration: 0.42, delay: 0.72 + index * 0.08, ease: EASE_HOUSE }}
                style={{ transformOrigin: `${cx}px ${cy}px` }}
              />
            ))}
          </>
        )}
      </motion.svg>
    </motion.div>
  );
}

function visibleLogoTarget() {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("[data-orbit-logo-target]")
  );
  return candidates.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function destinationForLogo(): Destination {
  const rect = visibleLogoTarget()?.getBoundingClientRect();
  if (!rect) {
    return { x: 40 - window.innerWidth / 2, y: 40 - window.innerHeight / 2, scale: 0.5 };
  }
  return {
    x: rect.left + rect.width / 2 - window.innerWidth / 2,
    y: rect.top + rect.height / 2 - window.innerHeight / 2,
    scale: Math.max(0.34, Math.min(0.62, rect.width / 96)),
  };
}

function copyFor(event: PlanUpgradeEvent) {
  const comped = event.source === "comp";
  if (event.plan === "lifetime") {
    return {
      eyebrow: "YOURS FOR GOOD",
      title: "Orbit Lifetime",
      supporting: comped
        ? "Orbit Lifetime has been granted to you. No billing attached."
        : "Orbit Lifetime is yours. No renewal.",
      benefits: LIFETIME_BENEFITS,
    };
  }
  return {
    eyebrow: comped ? "PLAN UNLOCKED" : "PLAN UPGRADED",
    title: "Orbit Pro",
    supporting: comped
      ? "Orbit Pro has been unlocked for you."
      : "Your Orbit Pro subscription is active.",
    benefits: PRO_BENEFITS,
  };
}

function BrandHandoff({
  phase,
  destination,
  reduced,
  lifetime,
}: {
  phase: Phase;
  destination: Destination;
  reduced: boolean;
  lifetime: boolean;
}) {
  const showing = phase === "brand" || phase === "flight" || phase === "exit";
  const flying = phase === "flight" || phase === "exit";

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed left-1/2 top-1/2 z-[103] flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      initial={false}
      animate={{
        opacity: !showing || phase === "exit" ? 0 : 1,
        scale: flying ? destination.scale : showing ? 1 : 0.72,
        x: flying ? destination.x : 0,
        y: flying ? destination.y : 0,
        filter: showing ? "blur(0px)" : "blur(8px)",
      }}
      transition={
        reduced
          ? { duration: 0 }
          : flying
            ? { duration: 0.92, ease: EASE_HOUSE }
            : { duration: 0.52, ease: EASE_HOUSE }
      }
    >
      <span className="absolute inset-[5px] rounded-full bg-white shadow-[0_16px_50px_rgba(0,0,0,0.2)]" />
      <motion.svg
        className="absolute inset-0 size-full -rotate-90 overflow-visible"
        viewBox="0 0 96 96"
        animate={{ opacity: phase === "flight" ? 0.45 : showing ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.36 }}
      >
        <motion.circle
          cx="48"
          cy="48"
          r="43"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          className={lifetime ? "text-[#f2c14e]" : "text-brand-pro"}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: showing ? 1 : 0 }}
          transition={{
            duration: reduced ? 0 : 0.86,
            ease: EASE_HOUSE,
          }}
        />
      </motion.svg>
      <motion.div
        className="relative rounded-full"
        animate={{ scale: showing ? 1 : 0.8 }}
        transition={{ duration: reduced ? 0 : 0.5, ease: EASE_HOUSE }}
      >
        <OrbitLogo size="xl" priority />
      </motion.div>
    </motion.div>
  );
}

function ProReveal({ phase, reduced }: { phase: Phase; reduced: boolean }) {
  const contentVisible = phase === "reveal" || phase === "ready";
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#599de7] text-white">
      <SpaceAtmosphere lifetime={false} phase={phase} reduced={reduced} />
      <motion.div
        aria-hidden="true"
        className="absolute inset-[5.5vw] rounded-[clamp(2rem,4vw,4.5rem)] border border-white/45 bg-white/[0.055] shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_32px_100px_rgba(13,58,126,0.2)]"
        initial={{ opacity: 0, scale: 0.82, borderRadius: "9rem" }}
        animate={{
          opacity: contentVisible ? 1 : 0.3,
          scale: contentVisible ? 1 : 1.04,
          borderRadius: contentVisible ? "clamp(2rem,4vw,4.5rem)" : "2rem",
        }}
        transition={{ duration: 1.05, ease: EASE_HOUSE }}
      >
        <motion.div
          className="absolute inset-y-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/20 to-transparent blur-xl"
          initial={{ x: "-160%" }}
          animate={{ x: contentVisible ? "430%" : "-160%" }}
          transition={{ duration: 1.55, delay: 0.35, ease: EASE_HOUSE }}
        />
      </motion.div>
    </div>
  );
}

function LifetimeReveal({ phase, reduced }: { phase: Phase; reduced: boolean }) {
  const contentVisible = phase === "reveal" || phase === "ready";
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#f2c14e] text-[#211a08]">
      <SpaceAtmosphere lifetime phase={phase} reduced={reduced} />
      <motion.div
        aria-hidden="true"
        className="absolute -right-[17vw] -top-[25vh] h-[150vh] w-[68vw] rotate-[13deg] rounded-[46%] border border-[#6d520c]/30 bg-[#8a6423]/[0.055] shadow-[-24px_0_60px_rgba(112,77,0,0.13),inset_1px_0_0_rgba(255,255,255,0.28)]"
        initial={{ x: "45%", opacity: 0 }}
        animate={{ x: contentVisible ? "0%" : "8%", opacity: contentVisible ? 1 : 0.35 }}
        transition={{ duration: 1.15, ease: EASE_HOUSE }}
      >
        <motion.div
          className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-[#8a6423]/10 to-transparent blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: contentVisible ? 1 : 0 }}
          transition={{ duration: 0.7, delay: 0.45 }}
        />
        {!reduced ? (
          <motion.div
            className="absolute -inset-y-[15%] w-24 rotate-[7deg] bg-gradient-to-r from-transparent via-white/35 to-transparent blur-md"
            initial={{ x: "-180%", opacity: 0 }}
            animate={{ x: contentVisible ? "850%" : "-180%", opacity: contentVisible ? [0, 0.8, 0] : 0 }}
            transition={{
              duration: 3.8,
              delay: 1.5,
              repeat: Infinity,
              repeatDelay: 1.4,
              ease: EASE_HOUSE,
            }}
          />
        ) : null}
      </motion.div>
    </div>
  );
}

function RevealCopy({ event, phase }: { event: PlanUpgradeEvent; phase: Phase }) {
  const lifetime = event.plan === "lifetime";
  const copy = copyFor(event);
  const visible = phase === "reveal" || phase === "ready";

  return (
    <motion.div
      className={
        lifetime
          ? "absolute inset-y-0 left-0 z-[101] flex w-full flex-col items-center justify-center px-6 text-center text-[#211a08] md:left-[8.25vw] md:w-[44vw] md:items-start md:px-0 md:text-left"
          : "absolute inset-y-0 left-0 z-[101] flex w-full flex-col items-center justify-center px-6 text-center text-white md:left-[8.25vw] md:w-[47vw] md:items-start md:px-0 md:text-left"
      }
      animate={{
        opacity: visible ? 1 : 0,
        scale: visible ? 1 : 0.965,
        filter: visible ? "blur(0px)" : "blur(8px)",
      }}
      transition={{ duration: 0.46, ease: EASE_HOUSE }}
    >
      <motion.p
        className="mb-5 text-xs font-semibold tracking-[0.3em] sm:text-sm"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.52, delay: 0.62, ease: EASE_HOUSE }}
      >
        {copy.eyebrow}
      </motion.p>
      <motion.h1
        className={
          lifetime
            ? "max-w-4xl font-[family-name:var(--font-display)] text-[clamp(4.4rem,8vw,8rem)] leading-[0.84] tracking-[-0.04em]"
            : "font-[family-name:var(--font-display)] text-[clamp(4.4rem,7.5vw,7.5rem)] leading-[0.9] tracking-[-0.04em]"
        }
        initial={{ opacity: 0, y: 38, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, delay: 0.82, ease: EASE_HOUSE }}
      >
        {lifetime ? (
          <>
            Orbit
            <br />
            Lifetime
          </>
        ) : (
          copy.title
        )}
      </motion.h1>
      <motion.p
        className={
          lifetime
            ? "mt-6 max-w-2xl text-lg font-medium sm:text-2xl"
            : "mt-6 max-w-2xl text-base text-white/90 sm:text-xl"
        }
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 1.35, ease: EASE_HOUSE }}
      >
        {copy.supporting}
      </motion.p>
      <motion.ul
        className={
          lifetime
            ? "mt-8 flex max-w-3xl flex-wrap justify-center gap-3 md:justify-start"
            : "mt-8 flex max-w-4xl flex-wrap justify-center gap-3 md:justify-start"
        }
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.58, delay: 1.72, ease: EASE_HOUSE }}
      >
        {copy.benefits.map(({ label, Icon }) => (
          <li
            key={label}
            className={
              lifetime
                ? "flex items-center gap-2 rounded-xl border border-[#513b05]/30 bg-[#8a6423]/[0.055] px-4 py-3 text-sm font-medium sm:text-base"
                : "flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 py-2.5 text-sm backdrop-blur-sm sm:px-5 sm:text-base"
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </li>
        ))}
      </motion.ul>
    </motion.div>
  );
}

export function PlanUpgradeCelebration({
  onLogoPresentationChange,
}: {
  onLogoPresentationChange?: (presentation: LogoPresentation) => void;
}) {
  const reduced = Boolean(useReducedMotion());
  const [event, setEvent] = useState<PlanUpgradeEvent | null>(null);
  const [phase, setPhase] = useState<Phase>("reveal");
  const [mainReady, setMainReady] = useState(false);
  const [destination, setDestination] = useState<Destination>({ x: 0, y: 0, scale: 0.5 });
  const claiming = useRef(false);
  const previewed = useRef(false);
  const timers = useRef<number[]>([]);
  const skipRef = useRef<HTMLButtonElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  const later = useCallback((callback: () => void, delay: number) => {
    const timer = window.setTimeout(callback, delay);
    timers.current.push(timer);
  }, []);

  const claimNext = useCallback(async () => {
    if (claiming.current) return;
    claiming.current = true;
    try {
      // Local visual-QA hook. Compiled out of production and never writes an event.
      if (process.env.NODE_ENV === "development" && !previewed.current) {
        const params = new URLSearchParams(window.location.search);
        const preview = params.get("planUnlockPreview");
        if (preview === "orbit" || preview === "lifetime") {
          previewed.current = true;
          setPhase(reduced ? "ready" : "reveal");
          setMainReady(reduced);
          setDestination({ x: 0, y: 0, scale: 0.5 });
          setEvent({
            id: `preview-${preview}`,
            plan: preview,
            source: params.get("comped") === "1" ? "comp" : preview === "orbit" ? "subscription" : "lifetime",
            createdAt: new Date().toISOString(),
          });
          onLogoPresentationChange?.({ plan: preview, hidden: true });
          return;
        }
      }

      const response = await fetch("/api/plan-upgrades/claim", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { event: PlanUpgradeEvent | null };
      if (payload.event) {
        setPhase(reduced ? "ready" : "reveal");
        setMainReady(reduced);
        setDestination({ x: 0, y: 0, scale: 0.5 });
        setEvent(payload.event);
        onLogoPresentationChange?.({ plan: payload.event.plan, hidden: true });
      }
    } catch {
      // A celebration is enhancement, never a reason to interrupt the app.
    } finally {
      claiming.current = false;
    }
  }, [onLogoPresentationChange, reduced]);

  useEffect(() => {
    const timer = window.setTimeout(() => void claimNext(), 0);
    return () => window.clearTimeout(timer);
  }, [claimNext]);

  useEffect(() => {
    if (!event) return;
    clearTimers();

    if (reduced) {
      return clearTimers;
    }

    later(() => {
      setMainReady(true);
      setPhase("ready");
    }, 2500);
    return clearTimers;
  }, [clearTimers, event, later, reduced]);

  useEffect(() => {
    if (!event) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [event]);

  useEffect(() => {
    if (mainReady) enterRef.current?.focus({ preventScroll: true });
  }, [mainReady]);

  const enterOrbit = useCallback((fast = false) => {
    if (!event || !mainReady) return;
    clearTimers();
    if (reduced) {
      onLogoPresentationChange?.({ plan: event.plan, hidden: false });
      setPhase("exit");
      later(() => setEvent(null), 120);
      return;
    }
    setPhase("brand");
    later(() => {
      setDestination(destinationForLogo());
      setPhase("flight");
    }, fast ? 330 : 1050);
    later(() => {
      onLogoPresentationChange?.({ plan: event.plan, hidden: false });
      setPhase("exit");
    }, fast ? 950 : 1970);
    later(() => setEvent(null), fast ? 1220 : 2420);
  }, [clearTimers, event, later, mainReady, onLogoPresentationChange, reduced]);

  const skip = useCallback(() => enterOrbit(true), [enterOrbit]);

  useEffect(() => {
    if (!event || !mainReady) return;
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [event, mainReady, skip]);

  return (
    <AnimatePresence
      onExitComplete={() => {
        // If two real upgrades landed before the user returned, celebrate them in order.
        void claimNext();
      }}
    >
      {event ? (
        <motion.section
          key={event.id}
          role="dialog"
          aria-modal="true"
          aria-label={`${copyFor(event).title} unlocked`}
          className="fixed inset-0 z-[100] isolate"
          initial={{ opacity: 0 }}
          animate={{ opacity: phase === "exit" ? 0 : 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : phase === "exit" ? 0.5 : 0.32 }}
        >
          {event.plan === "lifetime" ? (
            <LifetimeReveal phase={phase} reduced={reduced} />
          ) : (
            <ProReveal phase={phase} reduced={reduced} />
          )}
          <RevealCopy event={event} phase={phase} />

          <AnimatePresence>
            {mainReady && phase === "ready" ? (
              <motion.button
                ref={skipRef}
                type="button"
                onClick={skip}
                className={
                  event.plan === "lifetime"
                    ? "fixed right-5 top-5 z-[104] rounded-xl border border-[#211a08]/45 px-4 py-2 text-sm font-medium text-[#211a08] outline-none transition-colors hover:bg-[#211a08]/10 focus-visible:ring-2 focus-visible:ring-[#211a08]/70 sm:right-8 sm:top-8"
                    : "fixed right-5 top-5 z-[104] rounded-xl border border-white/35 bg-white/5 px-4 py-2 text-sm font-medium text-white outline-none backdrop-blur-sm transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/80 sm:right-8 sm:top-8"
                }
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: reduced ? 0 : 0.3, ease: EASE_HOUSE }}
              >
                Skip
              </motion.button>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {mainReady && phase === "ready" ? (
              <motion.button
                ref={enterRef}
                type="button"
                onClick={() => enterOrbit(false)}
                className={
                  event.plan === "lifetime"
                    ? "fixed bottom-[calc(5.5vw+1.5rem)] left-1/2 z-[104] -translate-x-1/2 rounded-full bg-[#211a08] px-7 py-3.5 text-sm font-semibold text-[#f2c14e] shadow-[0_14px_40px_rgba(65,43,0,0.24)] outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-[#211a08] focus-visible:ring-offset-4 focus-visible:ring-offset-[#f2c14e] sm:text-base"
                    : "fixed bottom-[calc(5.5vw+1.5rem)] left-1/2 z-[104] -translate-x-1/2 rounded-full bg-white px-7 py-3.5 text-sm font-semibold text-[#1e5ea7] shadow-[0_14px_40px_rgba(15,57,114,0.25)] outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-[#599de7] sm:text-base"
                }
                initial={{ opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.97 }}
                transition={{ duration: reduced ? 0 : 0.38, ease: EASE_HOUSE }}
              >
                Go into Orbit
              </motion.button>
            ) : null}
          </AnimatePresence>

          <BrandHandoff
            phase={phase}
            destination={destination}
            reduced={reduced}
            lifetime={event.plan === "lifetime"}
          />

          <span className="sr-only" aria-live="assertive">
            {copyFor(event).supporting}
          </span>
          {phase === "flight" ? (
            <span className="sr-only">
              <Check /> Upgrade complete
            </span>
          ) : null}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
