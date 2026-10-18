"use client";

// Outside every route group: it catches what the groups' own boundaries don't, such as
// /scan or a group layout that throws. Deliberately no stylesheet import: a root boundary's
// CSS would ride along with every page, and the tree it renders in already loaded one.
import { ErrorFallback } from "@/components/error-fallback";

export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // `/`, not the dashboard: as with not-found.tsx, a root boundary ships in every page's
  // payload, the waitlist's included, so it names no app path.
  return (
    <ErrorFallback
      error={error}
      retry={unstable_retry}
      home={{ href: "/", label: "Back to the homepage" }}
    />
  );
}
