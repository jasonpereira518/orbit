"use client";

import { useEffect } from "react";
import { LANDING_INTRO_ATTR, LANDING_INTRO_PREPAINT_SCRIPT } from "@/lib/landing-intro";

/**
 * Marks `<html>` for the first-visit intro before first paint (see `lib/landing-intro.ts`).
 *
 * Unlike `EarlyAccessPill`, this never sets the attribute from an effect: a client-side
 * navigation to `/` does not run the inline script, and that is the point — someone already
 * inside the site is not arriving. The cleanup takes the attribute away on unmount, so a later
 * client-side return to `/` gets today's page, not a replay of the staggered entrance.
 */
let pendingRemoval: number | undefined;

export function LandingIntroGate() {
  useEffect(() => {
    // Deferred and cancelled on remount: React's development double-run unmounts and remounts
    // every effect once on load, and removing synchronously there killed the intro outright.
    window.clearTimeout(pendingRemoval);
    return () => {
      pendingRemoval = window.setTimeout(
        () => document.documentElement.removeAttribute(LANDING_INTRO_ATTR),
        0
      );
    };
  }, []);
  return <script dangerouslySetInnerHTML={{ __html: LANDING_INTRO_PREPAINT_SCRIPT }} />;
}
