import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@neondatabase/serverless",
    "drizzle-orm",
  ],
};

export default nextConfig;
