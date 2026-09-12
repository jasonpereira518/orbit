import Image from "next/image";
import { cn } from "@/lib/utils";
import { PLAN_LABELS, type Plan } from "@/lib/plan-limits";

const SIZES = {
  sm: 28,
  md: 32,
  lg: 40,
  xl: 64,
  hero: 96,
} as const;

/**
 * A paid plan puts a coloured ring around the mark, in that tier's accent — the same two
 * colours the pricing page keys its cards to, so the badge a subscriber sees in the app is
 * recognisably the tier they bought.
 *
 * Written as whole literal class strings rather than interpolated colours because Tailwind
 * scans source text: `ring-[${hex}]` compiles to nothing. That is also why these hexes are
 * repeated from `pricing-tiers.tsx` and `plan-comparison.tsx` instead of being imported —
 * an arbitrary value has to be visible to the scanner at build time.
 *
 * The ring is drawn on a wrapper `span` sized to the logo's footprint, not on the `Image`
 * itself: the mark is shrunk and centred inside that wrapper, leaving a transparent gap
 * between the mark's own edge and the ring. Drawing both from the same box (rather than
 * ring-offsetting off the image element) keeps the ring concentric with the mark instead of
 * drifting off-centre.
 *
 * `orbit-logo.png`'s painted disc isn't centred in its own square canvas — it sits ~10.5px
 * right of centre on the 512px source (verified by scanning for the disc's solid-colour
 * bounding box), which is also why a star tip bleeds past the disc's left edge with no
 * matching bleed on the right. `MARK_SHIFT_RATIO` nudges the rendered mark left to centre
 * the disc itself (not the canvas) inside the ring, which is what a viewer actually judges
 * "centred" against.
 */
const PLAN_RING: Record<Plan, string | null> = {
  free: null,
  orbit: "ring-[2.5px] ring-inset ring-brand-pro",
  lifetime: "ring-[2.5px] ring-inset ring-[#f2c14e]",
};

// Transparent breathing room between the mark's edge and the ring stroke, plus the stroke's
// own width — subtracted from each side so the ring sits just outside the shrunk mark.
const RING_GAP = 2;
const RING_WIDTH = 2.5;

const MARK_SHIFT_RATIO = 10.5 / 512;

export function OrbitLogo({
  size = "md",
  className,
  priority,
  plan,
}: {
  size?: keyof typeof SIZES;
  className?: string;
  priority?: boolean;
  /** Draws the tier ring. Omit (or pass "free") outside the signed-in app. */
  plan?: Plan | null;
}) {
  const px = SIZES[size];
  const ring = plan ? PLAN_RING[plan] : null;

  if (!ring) {
    return (
      <Image
        src="/orbit-logo.png"
        alt="Orbit"
        width={px}
        height={px}
        priority={priority}
        className={cn("shrink-0 rounded-full", className)}
      />
    );
  }

  const markPx = px - 2 * (RING_GAP + RING_WIDTH);

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        ring,
        className,
      )}
      style={{ width: px, height: px }}
      // Colour alone should never be the only carrier of meaning: the ring is decorative,
      // and this is what names the plan for a pointer or a screen reader that surfaces it.
      title={PLAN_LABELS[plan!]}
    >
      <Image
        src="/orbit-logo.png"
        alt="Orbit"
        width={markPx}
        height={markPx}
        priority={priority}
        className="rounded-full"
        style={{ transform: `translateX(-${markPx * MARK_SHIFT_RATIO}px)` }}
      />
    </span>
  );
}
