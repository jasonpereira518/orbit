import Link from "next/link";
import type { ComponentType, JSX, ReactNode } from "react";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { DocToc, type TocItem } from "@/components/marketing/doc-toc";
import { OrbitLogo } from "@/components/orbit-logo";
import { cn } from "@/lib/utils";

const DOC_NAV = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

export type DocRoute = (typeof DOC_NAV)[number]["href"];

/**
 * Page chrome for /privacy, /terms and /contact. These pages deliberately
 * inherit the landing page's dark space canvas (not the themed app shell) so
 * the marketing surface reads as one continuous site.
 */
export function MarketingDocShell({
  active,
  children,
}: {
  active: DocRoute;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="relative flex min-h-screen flex-col overflow-hidden bg-[#05070f] text-[#e8f3f1]"
      style={{ backgroundImage: "var(--landing-page-gradient)" }}
    >
      <LandingStarfield />

      <header className="relative z-20 border-b border-[#e8f3f1]/[0.07]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4 md:px-10 md:py-5">
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-85"
            aria-label="Orbit home"
          >
            <OrbitLogo size="md" priority />
            <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]">
              Orbit
            </span>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/"
              className="hidden rounded-lg px-3 py-2 text-sm text-[#9aada8] transition-colors hover:text-[#e8f3f1] sm:inline-flex"
            >
              Back to home
            </Link>
            <Link
              href="/sign-in"
              className="rounded-lg bg-[#e8f3f1] px-3.5 py-2 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1">
        <DocNav active={active} />
        {children}
      </main>

      <LandingFooter />
    </div>
  );
}

function DocNav({ active }: { active: DocRoute }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 md:px-10 md:pt-10">
      <nav
        aria-label="Legal and contact"
        className="flex w-fit max-w-full flex-wrap items-center gap-1 rounded-full border border-[#e8f3f1]/[0.09] bg-[#e8f3f1]/[0.025] p-1"
      >
        {DOC_NAV.map((item) => {
          const isActive = item.href === active;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm transition-colors",
                isActive
                  ? "bg-[#e8f3f1]/[0.1] text-[#e8f3f1]"
                  : "text-[#9aada8] hover:text-[#e8f3f1]"
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
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

      <div className="landing-fade motion-reduce:translate-y-0 motion-reduce:opacity-100">
        <p className="text-xs uppercase tracking-[0.18em] text-landing-accent">
          {eyebrow}
        </p>
        <h1 className="mt-4 max-w-[17ch] font-[family-name:var(--font-display)] text-[clamp(40px,6.6vw,74px)] font-normal leading-[1.03] tracking-[-0.03em] text-[#e8f3f1]">
          {title}
        </h1>
        <p className="mt-6 max-w-[54ch] text-base leading-[1.75] text-[#9aada8] sm:text-lg">
          {lede}
        </p>

        {meta && meta.length > 0 && (
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-[#e8f3f1]/[0.07] pt-6">
            {meta.map((entry) => (
              <div key={entry.label}>
                <dt className="text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">
                  {entry.label}
                </dt>
                <dd className="mt-1 text-sm text-[#e8f3f1]">{entry.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
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
    <section className="landing-reveal mx-auto w-full max-w-6xl px-6 pb-16 md:px-10 md:pb-20">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
        {kicker}
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ icon: Icon, title, body }) => (
          <div key={title} className="landing-glass rounded-2xl p-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#f2c14e]/25 bg-[#f2c14e]/[0.08]">
              <Icon className="h-[18px] w-[18px] text-landing-accent" />
            </span>
            <p className="mt-4 text-[15px] text-[#e8f3f1]">{title}</p>
            <p className="mt-1.5 text-sm leading-[1.65] text-[#9aada8]">
              {body}
            </p>
          </div>
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
    <div className="mx-auto w-full max-w-6xl px-6 pb-20 md:px-10 md:pb-28">
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
    <section id={id} className="landing-reveal scroll-mt-24">
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
    </section>
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
    "inline-flex items-center justify-center rounded-xl bg-[#e8f3f1] px-5 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
  const secondaryClass =
    "inline-flex items-center justify-center rounded-xl border border-[#e8f3f1]/20 bg-[#e8f3f1]/[0.04] px-5 py-3 text-sm text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/35 hover:bg-[#e8f3f1]/[0.08]";

  return (
    <section className="landing-reveal mx-auto w-full max-w-6xl px-6 pb-20 md:px-10 md:pb-24">
      <div className="landing-glass flex flex-col gap-6 rounded-3xl p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
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
      </div>
    </section>
  );
}
