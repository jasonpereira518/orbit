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

const PLAN_RING: Record<Plan, string | null> = {
  free: null,
  orbit: "ring-[2.5px] ring-inset ring-brand-pro",
  lifetime: "ring-[2.5px] ring-inset ring-tier-lifetime",
};

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
  plan?: Plan | null;
}) {
  const px = SIZES[size];
  const ring = plan ? PLAN_RING[plan] : null;

  if (ring) {
    const markPx = px - 2 * (RING_GAP + RING_WIDTH);

    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full",
          ring,
          className,
        )}
        style={{ width: px, height: px }}
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
