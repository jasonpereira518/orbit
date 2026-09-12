"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Terms is deliberately absent from the site footer (see SceneFinale) but
 * present here: the document set stays complete and switchable once you are
 * inside it, without the landing page having to advertise it.
 */
export const DOC_ROUTES = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

/** Matches the landing header's nav indicator, so the two read as one system. */
const BUBBLE_SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 32,
  mass: 0.72,
};

/**
 * Segmented switcher between the three marketing documents.
 *
 * It lives in `(docs)/layout.tsx`, which Next keeps mounted across
 * privacy ↔ terms ↔ contact navigations — that persistence is what lets the
 * bubble travel to the new pill instead of cutting to it.
 */
export function DocSwitcher() {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <nav
      aria-label="Legal and contact"
      onMouseLeave={() => setHovered(null)}
      className="flex w-fit max-w-full items-center gap-1 rounded-full border border-[#e8f3f1]/[0.09] bg-[#e8f3f1]/[0.025] p-1"
    >
      <LayoutGroup id="doc-switcher">
        {DOC_ROUTES.map((route) => {
          const isActive = pathname === route.href;
          const isHovered = hovered === route.href;
          return (
            <Link
              key={route.href}
              href={route.href}
              aria-current={isActive ? "page" : undefined}
              onMouseEnter={() => setHovered(route.href)}
              className={cn(
                "relative inline-flex items-center rounded-full px-4 py-1.5 text-sm transition-colors",
                isActive
                  ? "text-[#e8f3f1]"
                  : "text-[#9aada8] hover:text-[#e8f3f1]"
              )}
            >
              {isActive && (
                <motion.span
                  aria-hidden="true"
                  layoutId="doc-switcher-bubble"
                  className="absolute inset-0 bg-[#e8f3f1]/[0.1] shadow-[0_0_18px_rgba(242,193,78,0.12)_inset]"
                  // The pills differ in width, so the bubble is scaled on the
                  // way across. Motion only undoes that distortion on the
                  // radius when it is an inline style — as a `rounded-full`
                  // class the ends go briefly elliptical mid-travel.
                  style={{ borderRadius: 9999 }}
                  transition={reduced ? { duration: 0 } : BUBBLE_SPRING}
                />
              )}
              {/* Hover tint sits under the bubble so the travelling pill is
                  never occluded by the cell it is moving into. */}
              {!isActive && isHovered && (
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-[#e8f3f1]/[0.04]"
                />
              )}
              <span className="relative z-10">{route.label}</span>
            </Link>
          );
        })}
      </LayoutGroup>
    </nav>
  );
}
