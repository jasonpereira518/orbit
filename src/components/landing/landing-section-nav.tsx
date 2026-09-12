"use client";

import { useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import {
  LayoutGroup,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  type MotionValue,
} from "motion/react";
import {
  LANDING_HEADER_SCROLL_OFFSET,
  LANDING_SECTIONS,
} from "@/components/landing/landing-sections";
import { cn } from "@/lib/utils";

const INDICATOR_SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 32,
  mass: 0.72,
};

const MAGNETIC_STRENGTH = 0.14;
const MAGNETIC_MAX = 3;

function scrollToSection(id: string, smooth: boolean) {
  const el = document.getElementById(id);
  if (!el) return;

  const top =
    el.getBoundingClientRect().top +
    window.scrollY -
    LANDING_HEADER_SCROLL_OFFSET;

  window.scrollTo({
    top: Math.max(0, top),
    behavior: smooth ? "smooth" : "auto",
  });
}

function useMagneticOffset(reduced: boolean | null) {
  const ref = useRef<HTMLAnchorElement>(null);
  const targetX = useMotionValue(0);
  const targetY = useMotionValue(0);
  const x = useSpring(targetX, { stiffness: 260, damping: 18, mass: 0.45 });
  const y = useSpring(targetY, { stiffness: 260, damping: 18, mass: 0.45 });

  const reset = () => {
    targetX.set(0);
    targetY.set(0);
  };

  const onMouseMove = (e: MouseEvent<HTMLAnchorElement>) => {
    if (reduced || !ref.current) return;

    const rect = ref.current.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);

    targetX.set(
      Math.max(-MAGNETIC_MAX, Math.min(MAGNETIC_MAX, dx * MAGNETIC_STRENGTH))
    );
    targetY.set(
      Math.max(-MAGNETIC_MAX, Math.min(MAGNETIC_MAX, dy * MAGNETIC_STRENGTH))
    );
  };

  return { ref, x, y, onMouseMove, reset };
}

function HighlightBox({
  x,
  y,
  reduced,
}: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  reduced: boolean | null;
}) {
  return (
    <motion.span
      layoutId="landing-nav-indicator"
      style={reduced ? undefined : { x, y }}
      className="pointer-events-none absolute inset-0 rounded-lg bg-[#e8f3f1]/[0.06]"
      transition={reduced ? { duration: 0 } : INDICATOR_SPRING}
    />
  );
}

function SectionNavLink({
  id,
  label,
  highlighted,
  active,
  reduced,
  onHover,
  onSelect,
}: {
  id: string;
  label: string;
  highlighted: boolean;
  active: boolean;
  reduced: boolean | null;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { ref, x, y, onMouseMove, reset } = useMagneticOffset(reduced);

  return (
    <a
      ref={ref}
      href={`#${id}`}
      aria-current={active ? "location" : undefined}
      onMouseEnter={onHover}
      onMouseMove={onMouseMove}
      onMouseLeave={reset}
      onClick={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        "relative inline-flex items-center shrink-0 rounded-lg px-2 py-1 text-xs sm:px-2.5 sm:text-sm",
        highlighted ? "text-[#e8f3f1]" : "text-[#9aada8]"
      )}
    >
      {highlighted ? <HighlightBox x={x} y={y} reduced={reduced} /> : null}
      <motion.span
        className="relative z-10"
        style={reduced ? undefined : { x, y }}
      >
        {label}
      </motion.span>
    </a>
  );
}

export function LandingSectionNav({
  activeId,
  setActiveId,
}: {
  activeId: string | null;
  setActiveId: (id: string) => void;
}) {
  const reduced = useReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const highlightId = hoveredId ?? activeId;

  return (
    <nav
      aria-label="Page sections"
      onMouseLeave={() => setHoveredId(null)}
      className="relative flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-x-auto sm:gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <LayoutGroup id="landing-section-nav">
        {LANDING_SECTIONS.map(({ id, label }) => (
          <SectionNavLink
            key={id}
            id={id}
            label={label}
            highlighted={highlightId === id}
            active={activeId === id}
            reduced={reduced}
            onHover={() => setHoveredId(id)}
            onSelect={() => {
              setActiveId(id);
              scrollToSection(id, !reduced);
              history.replaceState(null, "", `#${id}`);
            }}
          />
        ))}
      </LayoutGroup>
      {/* A route change, not a scroll target: it sits outside the LayoutGroup so the
          active-section indicator never tries to travel onto it, and outside
          LANDING_SECTIONS so the scroll-spy never claims it. */}
      <Link
        href="/pricing"
        className="relative inline-flex shrink-0 items-center rounded-lg px-2 py-1 text-xs text-[#9aada8] transition-colors hover:text-[#e8f3f1] sm:px-2.5 sm:text-sm"
      >
        Pricing
      </Link>
    </nav>
  );
}
