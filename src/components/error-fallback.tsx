"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { buttonVariants } from "@/components/ui/button";
import { onReconnect, useConnectivity } from "@/lib/connectivity-store";
import { isNetworkError } from "@/lib/errors";
import { cn } from "@/lib/utils";

/**
 * The one error boundary body, shared by every route group's `error.tsx`.
 *
 * Reports the error to Sentry from the browser (a render error inside a boundary never
 * reaches `onRequestError` on the server), then offers a retry and a way home.
 */
export function ErrorFallback({
  error,
  retry,
  home,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  home: { href: string; label: string };
}) {
  const { status } = useConnectivity();
  // The page failed because the connection did, not because Orbit is broken. Said as such,
  // not reported as a fault (a train tunnel is not a Sentry event), and retried by itself
  // the moment the connection is back.
  const offline = status !== "online" || isNetworkError(error);

  useEffect(() => {
    console.error(error);
    if (!offline) Sentry.captureException(error);
    // Decided once per error: a report must not fire later just because the connection
    // came back while this screen was up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useEffect(() => {
    if (!offline) return;
    return onReconnect(retry);
  }, [offline, retry]);

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">
        {offline ? "No connection" : "Something went wrong"}
      </p>
      <h1 className="font-[family-name:var(--font-display)] text-3xl tracking-tight text-ink">
        {offline
          ? status === "unreachable"
            ? "Can’t reach Orbit"
            : "You’re offline"
          : "We hit a snag"}
      </h1>
      <p className="text-muted-foreground">
        {offline
          ? "This page needs a connection to load. It’ll try again on its own as soon as you’re back."
          : "This page failed to load. You can try again or head back."}
      </p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={retry} className={cn(buttonVariants({ variant: "default" }))}>
          Try again
        </button>
        <Link href={home.href} className={cn(buttonVariants({ variant: "outline" }))}>
          {home.label}
        </Link>
      </div>
    </div>
  );
}
