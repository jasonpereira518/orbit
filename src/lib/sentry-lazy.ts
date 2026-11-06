/**
 * The one way client code reaches Sentry. Holds no static Sentry import, so nothing that
 * imports this (the instrumentation entry, the error boundaries, a server render of them)
 * pays for the SDK until it is needed. See `sentry-browser.ts`.
 */
type SentryBrowser = typeof import("@/lib/sentry-browser");

let loading: Promise<SentryBrowser | null> | null = null;
let loaded: SentryBrowser | null = null;

/** Load and initialize Sentry once. Resolves null without a DSN (local dev, previews without one). */
export function loadSentry(): Promise<SentryBrowser | null> {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return Promise.resolve(null);
  loading ??= import("@/lib/sentry-browser").then(
    (sdk) => (loaded = sdk),
    () => {
      loading = null; // a failed chunk load (offline) can be retried by the next report
      return null;
    }
  );
  return loading;
}

/** Sentry, if it has already loaded; never triggers a load. */
export function sentryIfLoaded(): SentryBrowser | null {
  return loaded;
}

/** Report an error, loading Sentry first if this is the first thing it hears about. */
export function reportClientError(error: unknown): void {
  void loadSentry().then((sdk) => sdk?.captureException(error));
}
