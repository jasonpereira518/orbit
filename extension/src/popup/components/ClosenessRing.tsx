import type { ClosenessTier } from "@contract";

const TIER_LABEL: Record<ClosenessTier, string> = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
};

const TIER_INDEX: Record<ClosenessTier, number> = { inner: 0, mid: 1, outer: 2 };

/** Three rings; the one this person sits in is lit. Orbit's whole metaphor, small. */
export function ClosenessRing({ tier }: { tier: ClosenessTier }) {
  const active = TIER_INDEX[tier];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={TIER_LABEL[tier]}
      aria-label={TIER_LABEL[tier]}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        {[7.5, 5, 2.5].map((r, i) => (
          <circle
            key={r}
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={i === 2 - active ? "var(--primary)" : "var(--border)"}
            strokeWidth={i === 2 - active ? 1.6 : 1}
          />
        ))}
        <circle cx="9" cy="9" r="1.4" fill="var(--primary)" />
      </svg>
      <span className="text-[11px] text-[var(--muted-foreground)]">
        {TIER_LABEL[tier]}
      </span>
    </span>
  );
}
