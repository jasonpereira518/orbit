"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { buttonVariants } from "@/components/ui/button";
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
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">Something went wrong</p>
      <h1 className="font-[family-name:var(--font-display)] text-3xl tracking-tight text-ink">
        Orbit hit a snag
      </h1>
      <p className="text-muted-foreground">
        This page failed to load. You can try again or head back.
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
