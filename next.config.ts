import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

export default nextConfig;
