"use client";

import { useEffect, useState } from "react";

/** True once the HeroPin section has fully scrolled past (solar pin released). */
export function usePastHeroPin(heroEl: HTMLElement | null) {
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    if (!heroEl) return;

    const check = () => {
      const cleared = heroEl.getBoundingClientRect().bottom <= 1;
      // Below md the pin runs 260svh, so waiting for it to clear left the
      // full-width header up for ~2.6 screens. Condense once the hero copy
      // has scrubbed away instead (beat 1 ends around 0.25 of the pin).
      const earlyOnMobile =
        window.innerWidth < 768 &&
        window.scrollY > window.innerHeight * 0.45;
      setPastHero(cleared || earlyOnMobile);
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
