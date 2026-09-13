"use client";

import { ErrorFallback } from "@/components/error-fallback";

export default function GroupError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <ErrorFallback
      error={error}
      retry={unstable_retry}
      home={{ href: "/", label: "Back to the homepage" }}
    />
  );
}
