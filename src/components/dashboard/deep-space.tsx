/**
 * The deep-space panel the dashboard's two foot cards share: /pricing's own sky gradient
 * with a few fixed stars on it. Static gradients rather than a canvas — this is decoration on
 * a dashboard, not a set piece worth an rAF loop.
 *
 * Painted in fixed colours, not theme tokens, on purpose: it is a window onto the same night
 * sky in light and dark mode, and the text laid over it is chosen to match.
 */
const WHITE = "232,243,241";

/**
 * One star: a firm core that fades out at the edge. The old stars were a bare
 * `color, transparent` gradient, which at 1px leaves only the centre pixel at full strength
 * and read as a faint speck; holding the colour to the middle of the radius gives a dot
 * that is still soft at its rim but visible at a glance.
 */
function star(radius: number, x: number, y: number, rgb: string, alpha: number) {
  return `radial-gradient(${radius}px ${radius}px at ${x}% ${y}%, rgba(${rgb},${alpha}) 0 55%, transparent 100%)`;
}

export function DeepSpace({ accent = "242,193,78" }: { accent?: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 140% at 50% 20%, #0f1630 0%, #0a1024 42%, #060915 72%, #03050c 100%)",
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-95"
        style={{
          backgroundImage: [
            star(1.9, 12, 24, WHITE, 1),
            star(1.5, 27, 68, WHITE, 0.75),
            star(2.1, 44, 18, accent, 1),
            star(1.5, 61, 52, WHITE, 0.7),
            star(1.7, 74, 28, WHITE, 0.95),
            star(1.5, 88, 62, WHITE, 0.65),
            star(1.8, 36, 84, WHITE, 0.8),
            star(1.6, 92, 16, accent, 0.85),
            star(1.5, 5, 78, WHITE, 0.7),
            star(1.7, 52, 90, WHITE, 0.8),
            star(1.5, 82, 88, WHITE, 0.6),
          ].join(","),
        }}
      />
    </>
  );
}
