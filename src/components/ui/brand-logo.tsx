"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The logo route answers a miss with a 1×1 blank rather than a 404. */
function isBlank(img: HTMLImageElement) {
  return img.complete && img.naturalWidth <= 1;
}

/**
 * A company's, school's or app's icon by domain, through `/api/logos/[domain]` (Google's
 * favicon, fetched server-side). A miss renders `fallback` instead of an empty slot; the ref
 * catches an image that settled before hydration. Key it on `domain` where it can change.
 */
export function BrandLogo({
  domain,
  name,
  fallback = null,
  className,
}: {
  domain: string;
  /** Its alt text and tooltip. Pass "" when the name is already written beside it. */
  name: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const [missed, setMissed] = useState(false);
  if (missed) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small same-origin favicon; next/image buys nothing here.
    <img
      src={`/api/logos/${domain}`}
      alt={name}
      title={name || undefined}
      width={16}
      height={16}
      loading="lazy"
      className={cn("size-4 shrink-0 rounded-sm", className)}
      ref={(el) => {
        if (el && isBlank(el)) setMissed(true);
      }}
      onLoad={(e) => isBlank(e.currentTarget) && setMissed(true)}
      onError={() => setMissed(true)}
    />
  );
}
