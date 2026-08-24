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
 * Where the blue disc actually sits inside `public/orbit-logo.png`, as fractions of the
 * frame. Measured off the source at full size: in the 512² frame the disc's centre is
 * (266.5, 255.5) with a radius of 244.5, while the frame's own centre is (255.5, 255.5).
 *
 * So the artwork is about 11px right of centre and tangent to the right edge, with the
 * constellation's leftmost star already clipped by the left edge. That is why the ring
 * cannot simply live on the element box: `rounded-full` draws a circle concentric with the
 * box, which at a 32px render puts it ~0.7px off the disc — the same order as the ring's
 * own width, so it reads as visibly uncentred.
 *
 * These numbers describe the asset, not a style choice. If the logo is ever redrawn
 * centred, they collapse to cx = cy = 0.5 and the offsets fall out on their own.
 */
const DISC = { cx: 266.5 / 512, cy: 255.5 / 512, r: 244.5 / 512 };

/** Air between the disc's edge and the ring, as a fraction of the frame. */
const RING_GAP = 0.03;

/**
 * A paid plan puts a coloured ring around the mark, in that tier's accent — the same two
 * colours the pricing page keys its cards to, so the badge a subscriber sees in the app is
 * recognisably the tier they bought.
 *
 * Written as whole literal class strings rather than interpolated colours because Tailwind
 * scans source text: `border-[${hex}]` compiles to nothing. That is also why these hexes
 * are repeated from `pricing-tiers.tsx` and `plan-comparison.tsx` instead of being imported
 * — an arbitrary value has to be visible to the scanner at build time.
 */
const PLAN_RING: Record<Plan, string | null> = {
  free: null,
  orbit: "border-[#599de7]",
  lifetime: "border-[#f2c14e]",
};

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

  const image = (
    <Image
      src="/orbit-logo.png"
      alt="Orbit"
      width={px}
      height={px}
      priority={priority}
      className={cn("shrink-0 rounded-full", !ring && className)}
    />
  );

  // No ring: render exactly what every unringed call site has always rendered, rather than
  // wrapping the mark in an element that could disturb their layout.
  if (!ring) return image;

  const r = DISC.r + RING_GAP;
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      // Colour alone should never be the only carrier of meaning: the ring is decorative,
      // and this names the plan for a pointer or a screen reader that surfaces it.
      title={PLAN_LABELS[plan!]}
    >
      {image}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute rounded-full border-[0.5px]",
          ring
        )}
        style={{
          width: pct(2 * r),
          height: pct(2 * r),
          left: pct(DISC.cx - r),
          top: pct(DISC.cy - r),
        }}
      />
    </span>
  );
}
