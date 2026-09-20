import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { buildSecurityHeaders } from "./src/lib/security-headers";
import { CAPTURE_BODY_SIZE_LIMIT } from "./src/lib/capture-limits";

const nextConfig: NextConfig = {
  // `*.bench.tsx` routes (the constellation benchmark, src/app/bench) exist only in a build
  // made with ORBIT_BENCH=1, so no deployed build ever contains them.
  pageExtensions: [
    "tsx",
    "ts",
    "jsx",
    "js",
    ...(process.env.ORBIT_BENCH === "1" ? ["bench.tsx"] : []),
  ],
  // HSTS, nosniff, referrer and frame policies, and a Content-Security-Policy that starts
  // report-only (CSP_ENFORCE=1 to enforce). See src/lib/security-headers.ts.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders({
          dev: process.env.NODE_ENV !== "production",
          enforce: process.env.CSP_ENFORCE === "1",
          clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        }),
      },
    ];
  },
  env: {
    // Inlined at build time; /api/health reports it so "which build is this" has an answer
    // even when the sha is unhelpful (a redeploy of the same commit).
    BUILD_TIME: new Date().toISOString(),
  },
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@neondatabase/serverless",
    "@google/genai",
    "drizzle-orm",
    "sharp",
  ],
  // The ticket-image route reads its fonts and the planet art from disk at request time;
  // without this the deploy bundle omits them and the route 500s only in production.
  outputFileTracingIncludes: {
    "/api/interest-list/ticket-image": [
      "./src/app/api/interest-list/ticket-image/fonts/*",
      "./public/landing/planets/*.png",
    ],
  },
  // Dev logs every Server Function call with its arguments by default, which prints the
  // API keys a person saves in Settings (saveAiSettings, saveOutreachSettings) into the
  // terminal verbatim.
  logging: {
    serverFunctions: false,
  },
  experimental: {
    // Route navigations animate via React's <ViewTransition> (route-transition.tsx).
    viewTransition: true,
    // Client router cache for dynamic pages. The default (0) re-renders a page on the
    // server on every visit, so going back to a tab you left seconds ago showed its
    // skeleton again for ~350ms minimum — React holds a Suspense reveal for 300ms once a
    // fallback is on screen. With 30s, a revisit inside the window is served from the
    // client (measured ~50ms, no skeleton; scripts/dev/nav-timing.mjs).
    //
    // Staleness is bounded by more than the timer: any Server Action that calls
    // revalidatePath/revalidateTag/refresh purges the whole client cache, the import and
    // capture watchers call router.refresh() when a job lands, and notifications come from
    // the app pulse, not from page renders. A NEW mutation path must do one of those, or a
    // quick revisit can show the pre-mutation page for up to this long.
    //
    // `static` is how long a FULL prefetch stays usable — the sidebar's `prefetchFull`
    // links (Dashboard, Contacts and Reminders; see app-nav.ts) render the whole destination
    // ahead of the click. The default is 5 minutes, which would let a click show a page that
    // old; 60s bounds that, and hovering a link whose prefetch has expired fetches it again,
    // so a mouse user still usually lands on warm data. It also covers statically generated
    // pages, which is harmless: those change only on deploy.
    staleTimes: { dynamic: 30, static: 60 },
    // Tree-shake icon/date/motion/clerk imports across the app bundle.
    optimizePackageImports: [
      "lucide-react",
      "date-fns",
      "motion",
      "@clerk/nextjs",
      "@clerk/ui",
      // three's entry is a barrel; deep-path rewriting is what keeps the
      // lazy earth-globe chunk from pulling loaders/controls/post-processing.
      "three",
    ],
    // Capture media (voice/photos) is sent as base64 through server actions.
    serverActions: {
      bodySizeLimit: CAPTURE_BODY_SIZE_LIMIT,
    },
    // MUST MATCH the server action limit above. `src/proxy.ts` exists and its matcher
    // covers server action POSTs, so Next buffers every non-GET body in memory — and at
    // the 10MB default it silently truncates anything larger and lets the request through
    // with a partial body instead of failing. See src/lib/capture-limits.ts.
    proxyClientMaxBodySize: CAPTURE_BODY_SIZE_LIMIT,
  },
  // Turbopack can fail to resolve @clerk/shared's wildcard `./*` package exports.
  turbopack: {
    resolveAlias: {
      "@clerk/shared/apiUrlFromPublishableKey":
        "./node_modules/@clerk/shared/dist/apiUrlFromPublishableKey.mjs",
      "@clerk/shared/underscore":
        "./node_modules/@clerk/shared/dist/underscore.mjs",
    },
  },
};

// Sentry's build plugin: injects the instrumentation and, when SENTRY_AUTH_TOKEN is set,
// uploads source maps. Without org/project/token it is a no-op wrapper, so local builds
// and previews are unaffected. Only Turbopack-safe options are passed.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
