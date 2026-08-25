"use client";

import { useEffect, useState } from "react";

/**
 * A relative timestamp ("3d", "2h") with the absolute value in the tooltip.
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
}: {
  date: Date | string | null | undefined;
  fallback?: string;
}) {
  const iso = normalizeIso(date);
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) return;
    const update = () => setLabel(relativeLabel(new Date(iso)));
    update();
    // Cheap enough to keep honest on a long-lived console tab.
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [iso]);

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

function relativeLabel(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (Math.abs(mins) < 1) return "just now";
  if (Math.abs(mins) < 60) return `${mins}m`;

  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return `${hours}h`;

  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 365) return `${days}d`;

  return `${Math.round(days / 365)}y`;
}
