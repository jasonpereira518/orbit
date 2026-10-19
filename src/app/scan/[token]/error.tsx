"use client";

import { ErrorFallback } from "@/components/error-fallback";

/**
 * The phone side of the QR hand-off has no app shell and no session, so the only way home
 * is the marketing root; the fallback's retry is what a flaky phone connection needs.
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
