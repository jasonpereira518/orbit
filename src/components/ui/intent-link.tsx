"use client";

import Link from "next/link";
import type { ComponentProps, FocusEvent, PointerEvent, TouchEvent } from "react";
import { useFullPrefetch, useIntentLinkPrefetch } from "@/lib/intent-prefetch";

/**
 * `<Link>` that prefetches the whole destination route — data included — as soon as the
 * pointer reaches it or it takes focus, so the click lands with no skeleton. Same props and
 * behavior as `<Link>` otherwise. See `@/lib/intent-prefetch` for why.
 *
 * `pointerdown` also kicks a full prefetch: a fast click often never fires a rested
 * `pointerenter` long enough for the React state upgrade, and the press itself is still
 * ~50–100 ms before navigation starts.
 */
export function IntentLink({
  prefetch,
  href,
  onPointerEnter,
  onPointerDown,
  onFocus,
  onTouchStart,
  ...props
}: ComponentProps<typeof Link>) {
  const intent = useIntentLinkPrefetch(prefetch);
  const fullPrefetch = useFullPrefetch();
  const hrefString = typeof href === "string" ? href : href.pathname ?? null;
  return (
    <Link
      {...props}
      href={href}
      prefetch={intent.prefetch}
      onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => {
        intent.onPointerEnter();
        onPointerEnter?.(e);
      }}
      onPointerDown={(e: PointerEvent<HTMLAnchorElement>) => {
        if (hrefString && e.button === 0) fullPrefetch(hrefString);
        onPointerDown?.(e);
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        intent.onFocus();
        onFocus?.(e);
      }}
      onTouchStart={(e: TouchEvent<HTMLAnchorElement>) => {
        intent.onTouchStart();
        onTouchStart?.(e);
      }}
    />
  );
}
