import * as Sentry from "@sentry/nextjs";

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
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
