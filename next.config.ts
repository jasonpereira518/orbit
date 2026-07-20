import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@neondatabase/serverless",
    "@google/genai",
    "drizzle-orm",
  ],
  experimental: {
    // lucide-react + date-fns are optimized by default; keep motion/clerk lean too.
    optimizePackageImports: ["motion", "@clerk/nextjs", "@clerk/ui"],
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
