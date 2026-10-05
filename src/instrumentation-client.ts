import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";
import { markNavStart } from "@/lib/nav-timing";

/**
 * Browser-side Sentry: hydration errors, client exceptions, and errors caught by the
 * error boundaries (`src/components/error-fallback.tsx`, `src/app/global-error.tsx`).
 * Inert without `NEXT_PUBLIC_SENTRY_DSN`. No session replay — it would eat the free
 * tier and record other people's contacts.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  sendDefaultPii: false,
  // Calendar, scan and MCP URLs carry their credential in the path (src/lib/sentry-scrub.ts).
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: (crumb) => scrubSentryEvent({ breadcrumbs: [crumb] }).breadcrumbs![0]!,
});

/**
 * Every client-side navigation starts here. Sentry gets its breadcrumb, and page-load timing
 * gets its clock start (`src/lib/nav-timing.ts`, read back by the pageview beacon).
 */
export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse"
) {
  markNavStart(url);
  Sentry.captureRouterTransitionStart(url, navigationType);
}
