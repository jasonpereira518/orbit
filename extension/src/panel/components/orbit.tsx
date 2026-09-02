/**
 * The orbit motif.
 *
 * Small, permanent, load-bearing — never decorative. It appears in exactly two
 * places: the verdict line (always), and the ring closing around the avatar
 * when a contact is created. No orbital backgrounds, no starfields, no
 * rotating anything. The landing page has the constellation set-piece; the
 * panel is the working tool and must not cosplay the marketing site.
 *
 * Tier colours are taken from the app's
 * src/components/dashboard/closeness-tier-badge.tsx — emerald / sky / amber.
 * There's a fair argument that inner/mid/outer are *positional* rather than
 * qualitative, and that colouring them implies "outer is bad". But the app
 * already made this call and users meet it on the dashboard first; an
 * extension that renders the same contact in different colours is worse than
 * an imperfect scale. Consistency wins.
 */
import type { ClosenessTier } from "@contract";
import { cn } from "@/lib/cn";

const TIER_LABEL: Record<ClosenessTier, string> = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
};

/** Matches closeness-tier-badge.tsx exactly. */
const TIER_PILL: Record<ClosenessTier, string> = {
  inner: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  mid: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  outer: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

const TIER_STROKE: Record<ClosenessTier, string> = {
  inner: "rgb(16 185 129)",
  mid: "rgb(14 165 233)",
  outer: "rgb(245 158 11)",
};

/** Which of the three rings is lit: inner = innermost. */
const TIER_RING: Record<ClosenessTier, number> = { inner: 0, mid: 1, outer: 2 };

const RADII = [2.5, 5, 7.5];

/**
 * Three concentric rings with the person's tier lit — and a dot sitting *on*
 * that ring's circumference. The dot is the whole metaphor: a body in orbit,
 * not merely a highlighted circle. It costs twelve characters of SVG.
 */
export function OrbitGlyph({
  tier,
  size = 18,
  className,
}: {
  tier: ClosenessTier;
  size?: number;
  className?: string;
}) {
  const active = TIER_RING[tier];
  const r = RADII[active];
  // 45°, so the dot never collides with the label sitting to the right.
  const cx = 9 + r * Math.cos(-Math.PI / 4);
  const cy = 9 + r * Math.sin(-Math.PI / 4);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      className={cn("shrink-0", className)}
      role="img"
      aria-label={TIER_LABEL[tier]}
    >
      {RADII.map((radius, i) => (
        <circle
          key={radius}
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke={i === active ? TIER_STROKE[tier] : "var(--border)"}
          strokeWidth={i === active ? 1.4 : 1}
        />
      ))}
      <circle cx={cx} cy={cy} r="1.6" fill={TIER_STROKE[tier]} />
    </svg>
  );
}

export function TierPill({
  tier,
  className,
}: {
  tier: ClosenessTier;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        TIER_PILL[tier],
        className
      )}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

/**
 * The Seal: a ring drawing clockwise around the avatar as a contact is created.
 *
 * The panel's one hero animation, which is exactly why it lands. `drawn`
 * toggles the stroke offset; reversing it un-draws on a failed save.
 */
export function SealRing({
  size,
  drawn,
  tier = "outer",
}: {
  size: number;
  drawn: boolean;
  tier?: ClosenessTier;
}) {
  const r = size / 2 - 1;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="pointer-events-none absolute inset-0"
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={TIER_STROKE[tier]}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={drawn ? 0 : circumference}
        // From 12 o'clock, clockwise.
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{
          transition:
            "stroke-dashoffset var(--transition-duration-slow, 320ms) var(--ease-house, ease)",
        }}
      />
    </svg>
  );
}
