"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { redactUrlForVendor } from "@/lib/analytics-routes";

/**
 * Vercel Web Analytics and Speed Insights, with every event's URL redacted first.
 *
 * A client component only because `beforeSend` is a function, and the root layout is a
 * server component that cannot hand one across. The redaction itself lives in
 * `redactUrlForVendor` — see there for what is dropped and why.
 */
function redactAnalytics(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = redactUrlForVendor(event.url);
  return url ? { ...event, url } : null;
}

function redactVital<T extends { url: string; route?: string }>(event: T): T | null {
  const url = redactUrlForVendor(event.url);
  if (!url) return null;
  // `route` is Next's own dynamic pattern and carries no ids; the URL is what leaked.
  return { ...event, url };
}

export function VercelTelemetry() {
  return (
    <>
      <Analytics beforeSend={redactAnalytics} />
      <SpeedInsights beforeSend={redactVital} />
    </>
  );
}
