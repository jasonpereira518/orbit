"use client";

import { ErrorFallback } from "@/components/error-fallback";
import { resetConstellationModules } from "@/components/graph/constellation-modules";

/**
 * The constellation's own error boundary, so its retry can do what the group's cannot.
 *
 * The chart's code chunks remember a failed download (see `constellation-modules.ts`); retrying
 * the route alone re-rendered into the same stored error, and "Try again" never recovered. The
 * modules are reset first so the retry actually asks for the chunks again.
 */
export default function GraphError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <ErrorFallback
      error={error}
      retry={() => {
        resetConstellationModules();
        unstable_retry();
      }}
      home={{ href: "/dashboard", label: "Go to dashboard" }}
    />
  );
}
