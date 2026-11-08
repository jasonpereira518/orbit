"use client";

import { ErrorFallback } from "@/components/error-fallback";

/**
 * The phone-side scan page sits outside every route group, so before this a failed handoff
 * lookup (a database blip, a cold start that timed out) fell through to the root
 * `global-error` screen. The phone has no session and nothing else to navigate to: offer a
 * retry, and the marketing home as the only way out.
 */
export default function ScanError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <ErrorFallback error={error} retry={unstable_retry} home={{ href: "/", label: "Go to Orbit" }} />;
}
