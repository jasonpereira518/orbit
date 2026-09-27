"use client";

import { useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type SectionTab = { href: string; label: string };

/**
 * A section's secondary tab row.
 *
 * Stays on one line and scrolls sideways when it runs out of room; wrapping a tab row puts
 * half the tabs under a rule that belongs to the other half. The rule is drawn as its own
 * layer under the scroller rather than as the nav's border: a scroll container clips its
 * children at the padding box, so an active underline pulled over the border with `-mb-px`
 * would be cut off.
 */
export function SectionTabs({
  label,
  tabs,
}: {
  label: string;
  /** The first tab is the section root and only matches its own path exactly. */
  tabs: SectionTab[];
}) {
  const pathname = usePathname();
  const root = tabs[0]?.href;
  const scroller = useRef<HTMLDivElement>(null);

  // On a narrow screen the active tab can sit past the right edge, leaving no visible sign
  // of where you are. Scroll the row (never the page — no `scrollIntoView`) to centre it.
  useLayoutEffect(() => {
    const row = scroller.current;
    const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !active) return;
    const start = active.offsetLeft;
    const end = start + active.offsetWidth;
    if (start >= row.scrollLeft && end <= row.scrollLeft + row.clientWidth) return;
    row.scrollLeft = start - (row.clientWidth - active.offsetWidth) / 2;
  }, [pathname]);

  return (
    <nav aria-label={label} className="relative mb-6">
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border/60" />
      <div
        ref={scroller}
        className="relative flex gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const active =
            tab.href === root
              ? pathname === root
              : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
