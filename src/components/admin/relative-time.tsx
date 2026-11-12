"use client";

import { useEffect, useState } from "react";
import { relativeLabel, type RelativeFormat } from "@/lib/relative-date";

/**
 * A relative timestamp with the absolute value in the tooltip. `format="short"` (default)
 * reads "3d", "2h"; `format="long"` reads "11 minutes ago". The wording lives in
 * `relativeLabel` (`src/lib/relative-date.ts`), so the component only owns the hydration
 * handling below.
 *
 * Client-side and effect-driven on purpose. A relative label is a function of "now", so
 * computing it during render is both a React purity violation and a real hydration
 * mismatch — the server renders "2h" and the client, milliseconds later, might render
 * "3h". Rendering the ISO date first and swapping to the relative label after mount is
 * stable, and it degrades to something still readable if JS never runs.
 */
export function RelativeTime({
  date,
  fallback = "—",
  format = "short",
}: {
  date: Date | string | null | undefined;
  fallback?: string;
  format?: RelativeFormat;
}) {
  const iso = normalizeIso(date);
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) return;
    const update = () => setLabel(relativeLabel(new Date(iso), new Date(), format));
    update();
    // Cheap enough to keep honest on a long-lived console tab.
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [iso, format]);

  if (!iso) return <span className="text-muted-foreground">{fallback}</span>;

  return (
    <time dateTime={iso} title={iso} className="tabular-nums">
      {label ?? iso.slice(0, 10)}
    </time>
  );
}

function normalizeIso(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
