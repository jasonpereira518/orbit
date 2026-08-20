"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { LandingSectionNav } from "@/components/landing/landing-section-nav";
import { useActiveLandingSection } from "@/components/landing/use-active-landing-section";
import { OrbitLogo } from "@/components/orbit-logo";
import { cn } from "@/lib/utils";

const FLUID_EASE = [0.22, 1, 0.36, 1] as const;

/** Soft settle with a hint of life — not bouncy, but not dead. */
const PILL_SPRING = {
  type: "spring" as const,
  stiffness: 340,
  damping: 30,
  mass: 0.82,
};

const GLASS_SPRING = {
  type: "spring" as const,
  stiffness: 420,
  damping: 34,
  mass: 0.75,
};

function subscribeLg(cb: () => void) {
  const mq = window.matchMedia("(min-width: 1024px)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function useIsLgUp() {
  return useSyncExternalStore(
    subscribeLg,
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false
  );
}

export function LandingHeader({
  pastHero,
  clerkOn,
  demoMode = false,
  signedIn = false,
}: {
  pastHero: boolean;
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
}) {
  const reduced = useReducedMotion();
  const isLgUp = useIsLgUp();
  const wasPastHero = useRef(pastHero);
  const enteringNav = pastHero && !wasPastHero.current;
  const showSectionNav = pastHero && isLgUp;
  const { activeId, setActiveId } = useActiveLandingSection(showSectionNav);

  useEffect(() => {
    wasPastHero.current = pastHero;
  }, [pastHero]);

  const instant = reduced ? { duration: 0 } : undefined;

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <motion.div
        className="pointer-events-auto relative mx-auto overflow-hidden"
        initial={
          reduced || !enteringNav ? false : { y: -12, scale: 0.985 }
        }
        animate={{
          width: pastHero ? "min(calc(100% - 1.5rem), 72rem)" : "100%",
          marginTop: pastHero ? 12 : 0,
          borderRadius: pastHero ? 22 : 0,
          y: 0,
          scale: 1,
        }}
        transition={
          instant ?? {
            width: PILL_SPRING,
            marginTop: PILL_SPRING,
            borderRadius: PILL_SPRING,
            y: PILL_SPRING,
            scale: PILL_SPRING,
          }
        }
      >
        <motion.div
          aria-hidden
          className="landing-header-glass pointer-events-none absolute inset-0 z-0"
          style={{ position: "absolute" }}
          initial={false}
          animate={{
            opacity: pastHero ? 1 : 0,
            scale: pastHero ? 1 : 0.96,
          }}
          transition={
            instant ?? {
              opacity: { duration: 0.38, ease: FLUID_EASE },
              scale: GLASS_SPRING,
            }
          }
        />

        <div
          className={cn(
            "relative z-10 flex w-full items-center",
            pastHero
              ? cn(
                  "gap-2 px-3 py-2 sm:gap-3 sm:px-5 sm:py-2.5 md:px-6 md:py-3",
                  showSectionNav ? "justify-start" : "justify-between"
                )
              : "justify-between px-6 py-5 md:px-10"
          )}
        >
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 sm:gap-2.5"
            aria-label="Orbit home"
          >
            <OrbitLogo size="md" priority />
            <span
              className={cn(
                "font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]",
                pastHero ? "hidden sm:inline" : "inline"
              )}
            >
              Orbit
            </span>
          </Link>

          <AnimatePresence initial={false}>
            {showSectionNav ? (
              <motion.div
                key="section-nav"
                className="flex min-w-0 flex-1"
                initial={reduced ? false : { opacity: 0, y: 6, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={
                  reduced
                    ? undefined
                    : { opacity: 0, y: 4, filter: "blur(4px)" }
                }
                transition={
                  instant ?? {
                    opacity: { duration: 0.32, ease: FLUID_EASE, delay: 0.08 },
                    y: GLASS_SPRING,
                    filter: { duration: 0.32, ease: FLUID_EASE, delay: 0.08 },
                  }
                }
              >
                <LandingSectionNav activeId={activeId} setActiveId={setActiveId} />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="shrink-0">
            <LandingAuthControls
              clerkOn={clerkOn}
              demoMode={demoMode}
              signedIn={signedIn}
              variant="header"
            />
          </div>
        </div>
      </motion.div>
    </header>
  );
}
