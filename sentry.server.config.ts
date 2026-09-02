import * as Sentry from "@sentry/nextjs";

/**
 * Server-side Sentry. Loaded from `src/instrumentation.ts` on the Node runtime.
 *
 * Sentry owns the exceptions nobody anticipated — a thrown render, a failed server action,
 * a route handler 500. Known conditions (a cron that stopped, a rolled webhook secret)
 * are the ops sweep's job (`src/lib/ops-sweep.ts`), and `error_events` stays a closed set.
 * Without a DSN this is inert, and `src/lib/request-errors.ts` falls back to Slack.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? "development",
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  // Errors are the point; a light trace sample keeps the free tier's quota for them.
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
