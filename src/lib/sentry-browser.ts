/**
 * Browser-side Sentry, initialized on import: hydration errors, client exceptions, and errors
 * caught by the error boundaries. Inert without `NEXT_PUBLIC_SENTRY_DSN`. No session replay —
 * it would eat the free tier and record other people's contacts.
 *
 * Never import this statically: it is ~83 KB gzipped, and loading it at startup put it on
 * every route's critical path (the landing page's cold load included). `sentry-lazy.ts` loads
 * it after the page is up, or at once when an error needs reporting. Named imports, not the
 * namespace, so the chunk keeps only what is used here.
 */
import { captureException, captureRouterTransitionStart, init } from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

init({
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
  beforeBreadcrumb: (crumb) => scrubSentryEvent({ breadcrumbs: [crumb] }).breadcrumbs[0],
});

export { captureException, captureRouterTransitionStart };
