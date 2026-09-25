"use client";

import Link from "next/link";
import type { ComponentProps, FocusEvent, PointerEvent, TouchEvent } from "react";
import { useIntentLinkPrefetch } from "@/lib/intent-prefetch";

/**
 * `<Link>` that prefetches the whole destination route — data included — as soon as the
 * pointer reaches it or it takes focus, so the click lands with no skeleton. Same props and
 * behavior as `<Link>` otherwise. See `@/lib/intent-prefetch` for why.
 */
export function IntentLink({
  prefetch,
  onPointerEnter,
  onFocus,
  onTouchStart,
  ...props
}: ComponentProps<typeof Link>) {
  const intent = useIntentLinkPrefetch(prefetch);
  return (
    <Link
      {...props}
      prefetch={intent.prefetch}
      onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => {
        intent.onPointerEnter();
        onPointerEnter?.(e);
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
