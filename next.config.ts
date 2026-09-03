import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { buildSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
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
  experimental: {
    // Route navigations animate via React's <ViewTransition> (route-transition.tsx).
    viewTransition: true,
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
      bodySizeLimit: "32mb",
    },
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
