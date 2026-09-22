"use client";

import { useSyncExternalStore } from "react";
import { ExternalLink, Puzzle } from "lucide-react";
import { useExtensionPresence } from "@/components/extension/use-extension-presence";
import { EXTENSION_STORE_URL } from "@/lib/extension/links";
import { isDesktopChromium } from "@/lib/extension/presence";

const subscribeNever = () => () => {};

/**
 * One card at the end of setup: the extension, offered once, where it can
 * actually be installed. Nothing on a phone, Safari or Firefox (it can't be
 * added there), nothing for someone who already has it, and nothing while
 * that is being asked — so it never appears and then vanishes.
 */
export function ExtensionNudge() {
  const chromium = useSyncExternalStore(subscribeNever, isDesktopChromium, () => false);
  const presence = useExtensionPresence();
  if (!chromium || presence !== null) return null;

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card p-4">
      <Puzzle className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">Bring Orbit to LinkedIn</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          The Chrome extension tells you when you already know someone, and saves new people in
          one click. Free on every plan.
        </p>
        <a
          href={EXTENSION_STORE_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          Add to Chrome
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}
