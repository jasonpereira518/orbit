"use client";

import { useEffect } from "react";
import { pokeExtensionSession } from "@/lib/extension/presence";

/**
 * Tells the Orbit extension, if it's installed, that there is a signed-in
 * session here — so a side panel sitting on "Sign in" picks it up by itself
 * instead of waiting for "I've signed in".
 *
 * Renders nothing. Mounted once in `(app)/layout.tsx`, which mounts fresh when
 * sign-in lands in the app. The message carries no data; a panel that is
 * already signed in ignores it; with no extension (or no configured ID) it is
 * a no-op that never leaves the page.
 */
export function ExtensionSessionBridge() {
  useEffect(() => {
    pokeExtensionSession();
  }, []);
  return null;
}
