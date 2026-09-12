"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type TocItem = { id: string; label: string };

/**
 * Sticky "on this page" rail for the long legal documents. Below lg, where
 * there is no room for a side rail, it collapses into a disclosure.
 */
export function DocToc({ items }: { items: readonly TocItem[] }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    // Anchors are zero-height spans; spy on the section that owns each one so
    // the highlight tracks a real block instead of a single crossing line.
    const sections = items
      .map((item) => document.getElementById(item.id)?.closest("section"))
      .filter((el): el is HTMLElement => el instanceof HTMLElement);
    if (sections.length === 0) return;

    const idFor = new Map(
      sections.map((section, i) => [section, items[i].id] as const)
    );

    // The bottom inset keeps the highlight on the section occupying the top of
    // the viewport rather than jumping to whatever is barely visible at the fold.
    const observer = new IntersectionObserver(
      (entries) => {
        const topMost = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          )[0];
        const id = topMost && idFor.get(topMost.target as HTMLElement);
        if (id) setActive(id);
      },
      { rootMargin: "-88px 0px -68% 0px", threshold: 0 }
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  const links = (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={isActive ? "true" : undefined}
              // Collapse the mobile disclosure on pick, so the jump lands on
              // content rather than on a list that is still covering it.
              onClick={() => {
                if (detailsRef.current) detailsRef.current.open = false;
              }}
              className={cn(
                "group flex items-start gap-2.5 rounded-lg py-1.5 pl-2.5 pr-2 text-[13px] leading-snug transition-colors",
                isActive
                  ? "bg-[#e8f3f1]/[0.05] text-[#e8f3f1]"
                  : "text-[#6d807c] hover:text-[#9aada8]"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full transition-colors",
                  isActive
                    ? "bg-landing-accent shadow-[0_0_8px_rgba(242,193,78,0.7)]"
                    : "bg-[#e8f3f1]/20 group-hover:bg-[#e8f3f1]/35"
                )}
              />
              {item.label}
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <details
        ref={detailsRef}
        className="landing-glass doc-faq rounded-2xl px-4 py-3 lg:hidden"
      >
        <summary className="flex items-center justify-between text-sm text-[#e8f3f1]">
          On this page
          <ChevronDown
            aria-hidden="true"
            className="doc-faq-chevron h-4 w-4 shrink-0 text-[#6d807c] transition-transform"
          />
        </summary>
        <div className="mt-3 border-t border-[#e8f3f1]/[0.07] pt-3">{links}</div>
      </details>

      <nav
        aria-label="On this page"
        className="hidden lg:sticky lg:top-8 lg:block lg:self-start"
      >
        <p className="mb-3 pl-2.5 text-[11px] uppercase tracking-[0.18em] text-[#6d807c]">
          On this page
        </p>
        {links}
      </nav>
    </>
  );
}
