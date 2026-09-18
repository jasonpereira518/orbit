import Link from "next/link";
import { PartyPopper, Send, Sparkles, type LucideIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * What renders in place of a page that is announced but not released (`comingSoon` in
 * `src/lib/surfaces.ts`).
 *
 * The third "you can't use this" screen, and separate from the other two for the reason
 * `SurfaceUnavailable` gives: `LockedFeature` sells, `SurfaceUnavailable` apologises, and
 * this one promises. It has no action to offer either, so it is allowed to be a picture.
 *
 * The picture is a dry dock: the feature is a planet still inside its scaffolding, with the
 * page's own nav icon hanging from the crane, and hazard tape strung across the front.
 * Server-rendered SVG + CSS loops (see "Coming soon" in globals.css), no client JS — so it
 * paints with the document and keeps moving in a tab that is starved of animation frames.
 */

type Feature = { icon: LucideIcon; teaser: string };

/** Keyed by surface key. A page marked coming-soon without an entry gets the fallback. */
const FEATURES: Record<string, Feature> = {
  "page.events": {
    icon: PartyPopper,
    teaser:
      "One place for the conferences, meetups and dinners where you meet people, and who you spoke to at each. We're still bolting it together.",
  },
  "page.outreach": {
    icon: Send,
    teaser:
      "Campaigns that help you reach the right people at the right moment, in your own voice. It's still in the dry dock.",
  },
};

const FALLBACK: Feature = {
  icon: Sparkles,
  teaser: "We're still building this part of Orbit. It will open here when it's ready.",
};

const TAPE_PHRASES = ["Under construction", "Coming soon", "Under construction", "Coming soon"];

const STARS: Array<[cx: number, cy: number, r: number]> = [
  [22, 40, 1.2],
  [300, 22, 1],
  [52, 286, 1.1],
  [292, 250, 1.3],
  [20, 176, 0.9],
  [186, 12, 1],
];

function DryDock({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 320 320"
      className="size-64 shrink-0 sm:size-72 md:size-80"
      fill="none"
    >
      <g className="hidden fill-foreground/70 dark:block">
        {STARS.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </g>

      <g className="coming-soon-ring">
        <circle cx={160} cy={160} r={128} className="stroke-primary/35" strokeDasharray="2 9" />
        <circle cx={288} cy={160} r={4.5} className="fill-warning" />
      </g>
      <g className="coming-soon-ring-reverse">
        <circle cx={160} cy={160} r={96} className="stroke-warning/50" strokeDasharray="14 8" />
        <circle cx={64} cy={160} r={2.5} className="fill-primary/70" />
      </g>

      <circle cx={160} cy={160} r={48} className="fill-card stroke-primary/80" />
      <g className="stroke-primary/40">
        <ellipse cx={160} cy={160} rx={48} ry={17} />
        <ellipse cx={160} cy={160} rx={20} ry={48} />
      </g>

      <path
        className="stroke-warning/80"
        d="M96 96H224V224H96ZM139 96V224M181 96V224M96 139H224M96 181H224M96 96L139 139M181 181L224 224M224 96L181 139"
      />

      <g className="stroke-muted-foreground" strokeWidth={2} strokeLinecap="round">
        <path d="M250 262V34M100 34H278M250 66L214 34M250 66L272 34" />
        <path d="M234 264H266" strokeWidth={5} />
      </g>
      <rect x={266} y={34} width={14} height={12} rx={2} className="fill-muted-foreground" />
      <circle cx={250} cy={27} r={3} className="coming-soon-blink fill-warning" />

      <g className="coming-soon-sway">
        <line x1={118} y1={34} x2={118} y2={60} className="stroke-muted-foreground" />
        <Icon x={105} y={60} width={26} height={26} className="text-warning" strokeWidth={1.75} />
      </g>
    </svg>
  );
}

function HazardTape() {
  // Two identical halves: the track slides left by exactly one of them and loops unseen.
  const half = (hidden: boolean) => (
    <div className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
      {TAPE_PHRASES.map((phrase, i) => (
        <span key={i} className="flex items-center">
          <span className="px-5 text-[11px] font-semibold tracking-[0.22em] whitespace-nowrap uppercase">
            {phrase}
          </span>
          <span className="h-7 w-14 bg-[repeating-linear-gradient(135deg,#1a1406_0_7px,transparent_7px_14px)]" />
        </span>
      ))}
    </div>
  );
  return (
    <div aria-hidden="true" className="pointer-events-none relative mt-3 h-14 md:-mt-12">
      <div className="absolute top-1/2 -right-10 -left-10 -translate-y-1/2 -rotate-3 overflow-hidden bg-[#f2c14e] text-[#1a1406] shadow-md md:-rotate-2">
        <div className="coming-soon-marquee flex w-max">
          {half(false)}
          {half(true)}
        </div>
      </div>
    </div>
  );
}

export function ComingSoon({ surfaceKey, label }: { surfaceKey: string; label: string }) {
  const feature = FEATURES[surfaceKey] ?? FALLBACK;
  return (
    <div className="flex min-h-[calc(100dvh-16.5rem)] min-w-0 flex-col justify-center md:min-h-[calc(100dvh-11rem)]">
      <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/50">
        <div className="flex min-w-0 flex-col items-center gap-2 px-6 pt-6 md:flex-row md:justify-center md:gap-10 md:px-10 md:pt-8">
          <div className="reveal-mount">
            <DryDock icon={feature.icon} />
          </div>
          <div
            className="reveal-mount min-w-0 max-w-sm space-y-3 text-center md:text-left"
            style={{ "--reveal-delay": "80ms" } as React.CSSProperties}
          >
            <h1 className="font-[family-name:var(--font-display)] text-ink">
              <span className="block font-sans text-xs font-medium tracking-[0.2em] text-warning uppercase">
                {label}
              </span>
              <span className="mt-1 block text-4xl md:text-5xl">Coming soon</span>
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">{feature.teaser}</p>
          </div>
        </div>

        <div className="reveal-mount" style={{ "--reveal-delay": "200ms" } as React.CSSProperties}>
          <HazardTape />
        </div>

        <div className="flex justify-center px-6 pt-2 pb-6">
          <Link
            href="/dashboard"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
