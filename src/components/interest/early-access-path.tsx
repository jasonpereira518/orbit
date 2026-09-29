import { cn } from "@/lib/utils";

export type EarlyAccessStep = { title: string; body: string };

/*
 * The curve, in a 300 × 48 box stretched to the band's width. A quadratic from (0, 44) to
 * (300, 44) with its control at (150, -20): x runs linearly with t, so the three column
 * centres (x = 50, 150, 250) sit at t = 1/6, 1/2, 5/6, where the curve is at
 * y ≈ 26.2, 12 and 26.2. The stops are placed at exactly those heights, so they ride the
 * line at every width.
 */
const ARC = "M 0 44 Q 150 -20 300 44";
const STOP_Y = [26.2, 12, 26.2];
const BAND_H = 48;

/**
 * "How early access works" as one orbit rather than three cards: the steps are stops on a
 * single arc, the last one brighter — the destination. On phones the arc becomes a dashed
 * line down the left with the stops on it.
 *
 * Server-rendered, no JS. The arc draws itself once when the section is revealed (a CSS
 * animation keyed off `<Reveal>`'s `data-reveal="in"` on an ancestor, see globals.css);
 * without that — already on screen at load, or reduced motion — it is simply drawn.
 */
export function EarlyAccessPath({ steps }: { steps: readonly EarlyAccessStep[] }) {
  return (
    <div className="early-path relative">
      <svg
        aria-hidden="true"
        viewBox={`0 0 300 ${BAND_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 top-0 hidden w-full md:block"
        style={{ height: BAND_H }}
      >
        <path
          d={ARC}
          pathLength={1}
          fill="none"
          stroke="rgba(122, 168, 150, 0.35)"
          strokeWidth={1}
          className="early-path-draw"
        />
        <path
          d={ARC}
          fill="none"
          stroke="rgba(242, 193, 78, 0.4)"
          strokeWidth={1}
          strokeDasharray="2 7"
          vectorEffect="non-scaling-stroke"
          className="early-path-cadence"
        />
      </svg>

      <ol className="ml-2 grid gap-8 border-l border-dashed border-[#e8f3f1]/15 pl-7 md:ml-0 md:grid-cols-3 md:gap-0 md:border-l-0 md:pl-0">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <li key={step.title} className="relative md:px-6 md:text-center">
              {/* The stop: on the arc from md, on the left-hand line below it. */}
              <span
                aria-hidden="true"
                className="absolute -left-7 top-1 -translate-x-1/2 md:relative md:left-auto md:top-auto md:block md:h-12 md:translate-x-0"
              >
                <span
                  className={cn(
                    "early-path-stop block rounded-full md:absolute md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2",
                    last
                      ? "size-4 bg-[#ffe9a0] shadow-[0_0_0_4px_rgba(242,193,78,0.18),0_0_18px_rgba(242,193,78,0.8)]"
                      : "size-3 bg-[#f2c14e] shadow-[0_0_12px_rgba(242,193,78,0.6)]"
                  )}
                  style={{ top: STOP_Y[i] ?? BAND_H / 2, animationDelay: `${0.35 + i * 0.3}s` }}
                />
              </span>
              <p className="font-[family-name:var(--font-display)] text-2xl leading-none text-landing-accent md:mt-4">
                {i + 1}
              </p>
              <h3 className="mt-2 text-sm font-medium text-[#e8f3f1]">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8] md:mx-auto md:max-w-[30ch]">
                {step.body}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
