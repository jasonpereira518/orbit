"use client";

import { useEffect, useState } from "react";

/** True once the HeroPin section has fully scrolled past (solar pin released). */
export function usePastHeroPin(heroEl: HTMLElement | null) {
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    if (!heroEl) return;

    const check = () => {
      setPastHero(heroEl.getBoundingClientRect().bottom <= 1);
    };

    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [heroEl]);

  return pastHero;
}
