import Link from "next/link";
import type { JSX } from "react";

export function LandingFooter(): JSX.Element {
  return (
    <footer className="relative z-10 flex flex-col items-center gap-2 border-t border-white/10 px-6 py-8 text-sm text-[#6d807c] sm:flex-row sm:justify-between md:px-10">
      <Link href="/privacy" className="transition-colors hover:text-[#e8f3f1]">
        Privacy
      </Link>
      <a
        href="https://jasonpereira.live/"
        target="_blank"
        rel="noopener noreferrer"
        className="landing-credit-shimmer"
      >
        By Jason Pereira
      </a>
    </footer>
  );
}
