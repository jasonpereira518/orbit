import Link from "next/link";
import type { JSX } from "react";
import { OrbitLogo } from "@/components/orbit-logo";

const NAV_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

export function LandingFooter(): JSX.Element {
  return (
    <footer className="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-8 border-t border-[#e8f3f1]/[0.07] px-6 py-10 md:px-10 md:py-11">
      <Link href="/" className="flex items-center gap-2.5" aria-label="Orbit home">
        <OrbitLogo size="sm" />
        <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
          Orbit
        </span>
      </Link>

      <nav className="flex gap-6 text-sm">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-[#9aada8] transition-colors hover:text-[#e8f3f1]"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <a
        href="https://jasonpereira.live/"
        target="_blank"
        rel="noopener noreferrer"
        className="landing-credit-shimmer text-sm text-[#6d807c]"
      >
        By Jason Pereira
      </a>
    </footer>
  );
}
