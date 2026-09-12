"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Replaces the root layout when IT throws. Must carry its own <html>/<body> and cannot
 * use the app's fonts or Tailwind classes, so the styling is inline and deliberately plain.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          background: "#0b1020",
          color: "#e6e9f2",
        }}
      >
        <main style={{ maxWidth: 480, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 14, opacity: 0.8, margin: 0 }}>Something went wrong</p>
          <h1 style={{ fontSize: 28, margin: "8px 0 12px" }}>Orbit hit a snag</h1>
          <p style={{ opacity: 0.8, margin: "0 0 16px" }}>
            The page could not be shown. Trying again usually works.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, opacity: 0.6, margin: "0 0 16px" }}>Reference: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "1px solid #3a4468",
              background: "#1a2340",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
