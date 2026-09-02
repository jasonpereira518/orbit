import Link from "next/link";
import type { ComponentType, JSX, ReactNode } from "react";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { DocSwitcher } from "@/components/marketing/doc-switcher";
import { DocToc, type TocItem } from "@/components/marketing/doc-toc";
import { Reveal } from "@/components/motion/reveal";
import { OrbitLogo } from "@/components/orbit-logo";
import { BackControl } from "@/components/pricing/back-control";
import { cn } from "@/lib/utils";

/**
 * Chrome for /privacy, /terms and /contact. These pages inherit the landing
 * page's deep-space canvas rather than the themed app shell, so the whole
 * marketing surface reads as one site.
 *
 * Rendered from `(docs)/layout.tsx` so it survives navigation between the
 * three documents — the switcher's bubble animation depends on that.
 */
export function MarketingDocShell({
  clerkOn,
  demoMode,
  signedIn,
  children,
}: {
  clerkOn: boolean;
  demoMode: boolean;
  /** Server-known hint only; the header resolves the live state in the browser. */
  signedIn?: boolean;
  children: ReactNode;
}): JSX.Element {
  const authProps = { clerkOn, demoMode, signedIn };

  return (
    // `landing-root` is load-bearing: globals.css paints the body deep-space while it
    // is mounted, which is what stops a light strip appearing on overscroll. The
    // starfield renders position:fixed, so this root must stay free of transform/filter.
    //
    // Clipped on BOTH axes, not just x: the decorative glows are centred on their
    // sections and overhang them by hundreds of px, and the last one's tail was
    // adding scrollable dead space below the footer. `clip` rather than `hidden`
    // so this never becomes a scroll container — the TOC rail sticks to the
    // viewport, and the fixed starfield keeps the viewport as its containing block.
    <div className="landing-root relative overflow-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-6 py-6 sm:gap-4 md:px-10">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <BackControl />
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Orbit home"
          >
            <OrbitLogo size="sm" />
            {/* Below sm the wordmark is what pushes the auth controls into
                wrapping — the logo alone still identifies the link. */}
            <span className="hidden font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1] sm:inline">
              Orbit
            </span>
          </Link>
        </div>
        <LandingAuthControls {...authProps} variant="header" />
      </header>

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 md:px-10">
        <DocSwitcher />
      </div>

      <main className="relative z-10">{children}</main>

      {/* Lighter on the bottom than the top: there is nothing after this row,
          so symmetric padding just reads as a gap at the end of the page. */}
      <footer className="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6 pb-7 pt-12 md:px-10">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Orbit home">
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
            Orbit
          </span>
        </Link>
        <div className="flex items-center gap-6">
          {[
            { href: "/pricing", label: "Pricing" },
            { href: "/privacy", label: "Privacy" },
            { href: "/contact", label: "Contact" },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]"
            >
              {link.label}
            </Link>
          ))}
        </div>
        <a
          href="https://jasonpereira.live/"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-credit-shimmer text-sm"
        >
          By Jason Pereira
        </a>
      </footer>
    </div>
  );
}

export function DocHero({
  eyebrow,
  title,
  lede,
  meta,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  meta?: readonly { label: string; value: string }[];
}): JSX.Element {
  return (
    <section className="relative mx-auto w-full max-w-6xl px-6 pb-12 pt-10 md:px-10 md:pb-16 md:pt-14">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-56 left-0 -z-10 h-[620px] w-[820px] max-w-full rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(242,193,78,0.13), transparent 62%)",
        }}
      />

      <Reveal className="reveal-celestial">
        <p className="text-xs uppercase tracking-[0.18em] text-landing-accent">
          {eyebrow}
        </p>
        <h1 className="mt-4 max-w-[17ch] font-[family-name:var(--font-display)] text-[clamp(38px,6.4vw,72px)] font-normal leading-[1.04] tracking-[-0.03em] text-[#e8f3f1]">
          {title}
        </h1>
        <p className="mt-6 max-w-[54ch] text-base leading-[1.75] text-[#9aada8] sm:text-lg">
          {lede}
        </p>
      </Reveal>

      {meta && meta.length > 0 && (
        <Reveal className="reveal-celestial" delay={90}>
          {/* A grid rather than a wrapping flex row: at 390px the third entry
              would otherwise drop to its own line and lose the shared baseline. */}
          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-[#e8f3f1]/[0.07] pt-6 sm:flex sm:flex-wrap sm:gap-x-12">
            {meta.map((entry) => (
              <div key={entry.label}>
                <dt className="text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">
                  {entry.label}
                </dt>
                <dd className="mt-1 text-sm text-[#e8f3f1]">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      )}
    </section>
  );
}

export type Highlight = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
};

/** "The short version" card row that opens each document. */
export function DocHighlights({
  kicker,
  items,
}: {
  kicker: string;
  items: readonly Highlight[];
}): JSX.Element {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pb-16 md:px-10 md:pb-20">
      <Reveal className="reveal-celestial">
        <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
          {kicker}
        </p>
      </Reveal>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ icon: Icon, title, body }, index) => (
          <Reveal
            key={title}
            className="reveal-celestial landing-glass rounded-2xl p-5"
            delay={index * 60}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#f2c14e]/25 bg-[#f2c14e]/[0.08]">
              <Icon className="h-[18px] w-[18px] text-landing-accent" />
            </span>
            <p className="mt-4 text-[15px] text-[#e8f3f1]">{title}</p>
            <p className="mt-1.5 text-sm leading-[1.65] text-[#9aada8]">
              {body}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/** Two-column document body: sticky contents rail plus the sections. */
export function DocBody({
  toc,
  children,
}: {
  toc: readonly TocItem[];
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-20 md:px-10 md:pb-24">
      <div className="grid gap-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-16">
        <DocToc items={toc} />
        <div className="min-w-0 space-y-14">{children}</div>
      </div>
    </div>
  );
}

export function DocSection({
  id,
  index,
  title,
  children,
}: {
  id: string;
  index: number;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Reveal as="section" className="reveal-celestial scroll-mt-24">
      {/* The anchor is a zero-height sibling rather than an id on the Reveal
          itself: <Reveal> hides pending sections, and an id inside a hidden
          element still scrolls, but a TOC click would land on nothing. */}
      <span id={id} className="block scroll-mt-24" />
      <div className="flex items-baseline gap-3.5">
        <span
          aria-hidden="true"
          className="shrink-0 text-xs tabular-nums text-landing-accent/70"
        >
          {String(index).padStart(2, "0")}
        </span>
        <h2 className="font-[family-name:var(--font-display)] text-[clamp(21px,2.5vw,28px)] font-normal tracking-tight text-[#e8f3f1]">
          {title}
        </h2>
      </div>
      <div className="doc-prose mt-4 max-w-[68ch]">{children}</div>
    </Reveal>
  );
}

/** Emphasised aside inside a section — the thing a reader shouldn't miss. */
export function DocCallout({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-[#f2c14e]/20 bg-[#f2c14e]/[0.045] p-5">
      {title && (
        <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
          {title}
        </p>
      )}
      <div className={cn("doc-prose", title && "mt-2.5")}>{children}</div>
    </div>
  );
}

export function DocCardGrid({
  children,
  columns = 2,
}: {
  children: ReactNode;
  columns?: 2 | 3;
}): JSX.Element {
  return (
    <div
      className={cn(
        "grid gap-3",
        columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"
      )}
    >
      {children}
    </div>
  );
}

export function DocCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="landing-glass rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] text-[#e8f3f1]">{title}</p>
        {badge && (
          <span className="shrink-0 rounded-full border border-[#e8f3f1]/[0.14] px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#6d807c]">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm leading-[1.6] text-[#9aada8]">{children}</p>
    </div>
  );
}

/** Closing call-to-action band shared by all three documents. */
export function DocFooterCta({
  title,
  body,
  primary,
  secondary,
}: {
  title: string;
  body: string;
  primary: { href: string; label: string; external?: boolean };
  secondary?: { href: string; label: string };
}): JSX.Element {
  const primaryClass =
    "inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-5 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
  const secondaryClass =
    "inline-flex items-center justify-center rounded-full border border-[#e8f3f1]/20 bg-[#e8f3f1]/[0.04] px-5 py-3 text-sm text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/35 hover:bg-[#e8f3f1]/[0.08]";

  return (
    <section className="mx-auto w-full max-w-6xl px-6 pb-8 md:px-10">
      <Reveal className="reveal-celestial landing-glass flex flex-col gap-6 rounded-3xl p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="max-w-[20ch] font-[family-name:var(--font-display)] text-[clamp(24px,3.2vw,34px)] font-normal leading-[1.15] tracking-tight text-[#e8f3f1]">
            {title}
          </h2>
          <p className="mt-3 max-w-[48ch] text-base leading-[1.7] text-[#9aada8]">
            {body}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
          {primary.external ? (
            <a
              href={primary.href}
              target="_blank"
              rel="noopener noreferrer"
              className={primaryClass}
            >
              {primary.label}
            </a>
          ) : (
            <Link href={primary.href} className={primaryClass}>
              {primary.label}
            </Link>
          )}
          {secondary && (
            <Link href={secondary.href} className={secondaryClass}>
              {secondary.label}
            </Link>
          )}
        </div>
      </Reveal>
    </section>
  );
}
