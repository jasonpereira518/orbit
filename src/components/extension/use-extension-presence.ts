"use client";

import { useEffect, useState } from "react";
import { pingExtension, type ExtensionPresence } from "@/lib/extension/presence";

/**
 * "checking" until the extension answers or the ping times out (≤800ms, and
 * instant when no extension ID is configured), then its presence or null.
 * Surfaces that would pitch the extension render nothing while "checking",
 * so nobody who has it installed sees the pitch flash.
 */
export function useExtensionPresence(): ExtensionPresence | null | "checking" {
  const [presence, setPresence] = useState<ExtensionPresence | null | "checking">("checking");
  useEffect(() => {
    let live = true;
    void pingExtension().then((result) => {
      if (live) setPresence(result);
    });
    return () => {
      live = false;
    };
  }, []);
  return presence;
}
