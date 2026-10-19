"use client";

import { useEffect, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { IntentLink } from "@/components/ui/intent-link";
import { onReconnect, useConnectivity } from "@/lib/connectivity-store";
import { isNetworkError } from "@/lib/errors";
import { reportClientError } from "@/lib/sentry-lazy";

/**
 * The one frame for a page that did not render: the error boundaries and the two
 * not-found pages all draw into it, so "We hit a snag" and "Page not found" share a
 * height, a title style (the `PageHeader` h1) and a button row.
 */
export function ErrorFrame({
  eyebrow,
  title,
  description,
  reference,
  actions,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  /** A digest or reference the person can quote to support. */
  reference?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
      <h1 className="font-heading text-3xl text-ink">{title}</h1>
      <p className="max-w-md text-muted-foreground">{description}</p>
      {reference ? <p className="text-2xs text-muted-foreground">{reference}</p> : null}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{actions}</div>
    </div>
  );
}

/** The 404 body, shared by the root and the `(app)` not-found pages. */
export function NotFoundFrame({
  title = "We couldn’t find that page",
  description = "That link may be out of date, or the page has moved.",
  home,
}: {
  title?: ReactNode;
  description?: ReactNode;
  home: { href: string; label: string };
}) {
  return (
    <ErrorFrame
      eyebrow="404"
      title={title}
      description={description}
      actions={
        <IntentLink href={home.href} className={buttonVariants()}>
          {home.label}
        </IntentLink>
      }
    />
  );
}

/**
 * The one error boundary body, shared by every route group's `error.tsx`.
 *
 * Reports the error to Sentry from the browser (a render error inside a boundary never
 * reaches `onRequestError` on the server), then offers a retry and a way home.
 *
 * Sentry is reached through `sentry-lazy.ts`, never imported at the top. This boundary is on
 * every page, and its server render would resolve `@sentry/nextjs` to the whole Node SDK
 * (~1.7 MB) — loaded on every cold start for an effect that only ever runs in the browser.
 * In the browser the loader reuses the SDK if it has loaded, or loads it to report this.
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
    if (!offline) reportClientError(error);
    // Decided once per error: a report must not fire later just because the connection
    // came back while this screen was up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useEffect(() => {
    if (!offline) return;
    return onReconnect(retry);
  }, [offline, retry]);

  return (
    <ErrorFrame
      eyebrow={offline ? "No connection" : "Something went wrong"}
      title={
        offline
          ? status === "unreachable"
            ? "Can’t reach Orbit"
            : "You’re offline"
          : "We hit a snag"
      }
      description={
        offline
          ? "This page needs a connection to load. It’ll try again on its own as soon as you’re back."
          : "This page didn’t load. You can try again or head back."
      }
      reference={error.digest ? <>Reference: {error.digest}</> : undefined}
      actions={
        <>
          <Button type="button" onClick={retry}>
            Try again
          </Button>
          <IntentLink href={home.href} className={buttonVariants({ variant: "outline" })}>
            {home.label}
          </IntentLink>
        </>
      }
    />
  );
}
