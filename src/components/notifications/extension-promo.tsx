"use client";

import { useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { OrbitLogo } from "@/components/orbit-logo";
import { EXTENSION_STORE_URL } from "@/lib/plan-copy";
import { cn } from "@/lib/utils";

/**
 * In dark mode this banner keeps its light-mode face: a white card in a dark
 * panel, which is what makes it read as an ad rather than as one more
 * notification row.
 *
 * Done by re-declaring the light palette's tokens on the card instead of
 * hand-writing a `dark:` override per element. Tailwind's `@theme inline`
 * compiles `text-primary` to `var(--color-primary)`, which is itself
 * `var(--primary)` — an unresolved reference, so it picks up whatever
 * `--primary` is on the nearest ancestor. Overriding the variables here flips
 * every descendant at once, including the shadcn button variants, and keeps
 * working if someone adds a token-based utility inside later.
 *
 * Values are copied from the `:root` block in globals.css; keep them in step.
 */
const LIGHT_ON_DARK = [
  "dark:[--card:#ffffff]",
  "dark:[--foreground:#1a1c1a]",
  "dark:[--primary:#0f3d3e]",
  "dark:[--primary-foreground:#e8f3f1]",
  "dark:[--muted:#f0f2ee]",
  "dark:[--muted-foreground:#5f6760]",
  "dark:[--accent:#e7f0ee]",
  "dark:[--accent-foreground:#0f3d3e]",
  "dark:[--border:#e4e7e1]",
  "dark:[--ring:#0f3d3e]",
  "dark:[--import-connections:#5b5fc7]",
].join(" ");

const CTA_CLASS = cn(
  buttonVariants({ size: "sm" }),
  "h-7 bg-import-connections px-2.5 text-primary-foreground hover:bg-import-connections/85"
);

// Bump the suffix to resurface the banner for people who already dismissed it.
const DISMISS_KEY = "orbit-extension-promo-dismissed-v1";

function wasDismissed() {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // ignore quota / private mode
  }
}

/**
 * House ad for the Orbit browser extension, shown at the top of the
 * notifications panel.
 *
 * It sits above the real notifications rather than among them on purpose: this
 * is the one row nobody asked for, so it never borrows the shape of a reminder,
 * never counts toward the bell badge, and dismisses permanently on first ask.
 *
 * Free has the extension, so the banner is plan-independent; it renders only
 * once `NEXT_PUBLIC_EXTENSION_URL` names a published listing.
 */
export function ExtensionPromo() {
  // Read once at mount rather than in an effect, so someone who already
  // dismissed this never sees it flash back for a frame. Safe to read during
  // render here: the panel holds this component back until its client-side
  // fetch resolves, so it has no server-rendered output to mismatch.
  const [dismissed, setDismissed] = useState(wasDismissed);

  // Unpublished: there is no listing to send anyone to, so no banner.
  if (dismissed || !EXTENSION_STORE_URL) return null;

  return (
    <div
      className={cn(
        // The gradient's first two stops are translucent purple, so the card
        // needs an opaque base or the panel behind shows through its top-left
        // half. Written as an arbitrary property rather than `bg-card`, which
        // tailwind-merge folds into the same group as `bg-gradient-to-br` and
        // drops.
        "relative overflow-hidden rounded-xl border border-import-connections/40 [background-color:var(--card)] bg-gradient-to-br from-import-connections/[0.14] via-import-connections/[0.05] to-card p-3",
        LIGHT_ON_DARK
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss extension announcement"
        onClick={() => {
          rememberDismissed();
          setDismissed(true);
        }}
      >
        <X className="size-3.5" />
      </Button>

      <div className="flex items-start gap-3 pr-6">
        <OrbitLogo size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-heading text-base leading-snug text-primary">
            Get the Orbit browser extension
          </p>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
            Spot the people you already know on LinkedIn, and save new ones to
            Orbit in one click.
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={EXTENSION_STORE_URL}
              target="_blank"
              rel="noreferrer"
              className={CTA_CLASS}
            >
              Add to Chrome
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
