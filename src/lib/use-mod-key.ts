"use client";

import { useSyncExternalStore } from "react";

function isApplePlatform() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const subscribe = () => () => {};

/**
 * The label for the platform's command modifier: "⌘" on Apple devices, "Ctrl" everywhere
 * else. The shortcuts themselves already accept either key; this is only what we print.
 *
 * The server has no platform to read, so it renders "⌘" and hydration swaps in "Ctrl" on
 * Windows/Linux — `useSyncExternalStore` does that swap without a hydration mismatch.
 */
export function useModKeyLabel(): "⌘" | "Ctrl" {
  return useSyncExternalStore(
    subscribe,
    () => (isApplePlatform() ? "⌘" : "Ctrl"),
    () => "⌘"
  );
}
