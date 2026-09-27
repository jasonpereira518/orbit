import Link from "next/link";
import type { ReactNode } from "react";
import { OrbitLogo } from "@/components/orbit-logo";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/interest", label: "Interest list" },
  { href: "/privacy", label: "Privacy" },
  { href: "/contact", label: "Contact" },
] as const;

const LINK_CLASS =
  "inline-flex min-h-11 items-center whitespace-nowrap text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]";

/**
 * The footer every marketing page ends on. It used to be pasted into three pages, which is
 * how its links ended up 20px tall on all of them at once.
 *
 * Every link is a 44px-tall box, the comfortable thumb target, while the text stays
 * text-sm. The link row wraps rather than squeezing, so "Interest list" never breaks
 * across two lines on a 320px phone. The boxes already carry their own vertical air, which
 * is why the gaps between wrapped rows are tighter than the old ones.
 */
export function MarketingFooter({
  className,
  children,
}: {
  /** Width and horizontal padding: each page's column differs. */
  className?: string;
  /** Decoration anchored on the footer's own box (the landing page's glow). */
  children?: ReactNode;
}) {
  return (
    <footer
      className={cn(
        "relative z-10 mx-auto flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 py-12",
        className
      )}
    >
      {children}
      <Link href="/" className="flex min-h-11 items-center gap-2.5" aria-label="Orbit home">
        <OrbitLogo size="sm" />
        <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
          Orbit
        </span>
      </Link>
      <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={LINK_CLASS}>
            {link.label}
          </Link>
        ))}
      </nav>
      <a
        href="https://jasonpereira.live/"
        target="_blank"
        rel="noopener noreferrer"
        className="landing-credit-shimmer inline-flex min-h-11 items-center text-sm"
      >
        By Jason Pereira
      </a>
    </footer>
  );
}
