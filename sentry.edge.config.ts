import * as Sentry from "@sentry/nextjs";

/** Edge-runtime Sentry. Same policy as the server config; loaded from `src/instrumentation.ts`. */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? "development",
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
