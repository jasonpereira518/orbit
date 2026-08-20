"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LANDING_HEADER_SCROLL_OFFSET,
  LANDING_SECTIONS,
} from "@/components/landing/landing-sections";

function getSectionRoot(anchor: HTMLElement): HTMLElement {
  return anchor.closest(".landing-scene") ?? anchor.closest("section") ?? anchor;
}

function visibleHeight(
  el: HTMLElement,
  viewportTop: number,
  viewportBottom: number
) {
  const rect = el.getBoundingClientRect();
  const top = Math.max(rect.top, viewportTop);
  const bottom = Math.min(rect.bottom, viewportBottom);
  return Math.max(0, bottom - top);
}

/** Which landing section is currently in view (for header nav highlight). */
export function useActiveLandingSection(enabled: boolean) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const resolve = useCallback(() => {
    const viewportTop = LANDING_HEADER_SCROLL_OFFSET;
    const viewportBottom = window.innerHeight;
    const viewportCenter = (viewportTop + viewportBottom) / 2;

    let bestId: string | null = null;
    let bestVisible = 0;
    let bestCenterDist = Infinity;

    for (const { id } of LANDING_SECTIONS) {
      const anchor = document.getElementById(id);
      if (!anchor) continue;

      const section = getSectionRoot(anchor);
      const visible = visibleHeight(section, viewportTop, viewportBottom);
      if (visible <= 0) continue;

      const rect = section.getBoundingClientRect();
      const centerDist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);

      if (
        visible > bestVisible ||
        (visible === bestVisible && centerDist < bestCenterDist)
      ) {
        bestVisible = visible;
        bestCenterDist = centerDist;
        bestId = id;
      }
    }

    setActiveId(bestId);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setActiveId(null);
      return;
    }

    resolve();
    window.addEventListener("scroll", resolve, { passive: true });
    window.addEventListener("resize", resolve);
    return () => {
      window.removeEventListener("scroll", resolve);
      window.removeEventListener("resize", resolve);
    };
  }, [enabled, resolve]);

  return { activeId, setActiveId };
}
