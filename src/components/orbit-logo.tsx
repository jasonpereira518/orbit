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
 * The offset is transparent, not `background`: this mark sits on the sidebar's glass, and a
 * solid offset would punch a mismatched disc out of it. Transparent leaves a clean gap.
 *
 * 1px ring on a 1px offset, deliberately. The artwork is a ~490px disc centred in a 512px
 * frame, so it already carries roughly 0.7px of its own inset at the 32px render — a wider
 * offset stacks on top of that and the ring reads as a detached halo rather than a rim,
 * while dropping the offset entirely leaves the ring touching the disc.
 */
const PLAN_RING: Record<Plan, string | null> = {
  free: null,
  orbit: "ring-1 ring-offset-1 ring-offset-transparent ring-[#599de7]",
  lifetime: "ring-1 ring-offset-1 ring-offset-transparent ring-[#f2c14e]",
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
  return (
    <Image
      src="/orbit-logo.png"
      alt="Orbit"
      width={px}
      height={px}
      priority={priority}
      // Colour alone should never be the only carrier of meaning: the ring is decorative,
      // and this is what names the plan for a pointer or a screen reader that surfaces it.
      title={ring ? PLAN_LABELS[plan!] : undefined}
      className={cn("shrink-0 rounded-full", ring, className)}
    />
  );
}
