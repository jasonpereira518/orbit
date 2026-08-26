"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useWarp } from "@/components/warp/warp-provider";

/**
 * A link out of the app and into space.
 *
 * Renders a real anchor, so this degrades to an ordinary navigation whenever
 * the fancy path can't run: no JS, not yet hydrated, or a click the browser
 * should own (new tab, new window, download). Only a plain left-click is
 * intercepted, and only then does the lift-off play.
 *
 * Deliberately not wired into `(marketing)` — the landing and docs pages are
 * already in deep space, so launching from them would be a journey from orbit
 * to orbit. Those keep next/link.
 */
export function WarpLink({
  href = "/pricing",
  className,
  children,
  onClick,
  ...rest
}: React.ComponentPropsWithoutRef<"a"> & { href?: string }) {
  const router = useRouter();
  const { launch } = useWarp();
  const ref = useRef<HTMLAnchorElement>(null);

  // next/link would do this for us, but we need the bare anchor to own the
  // click. For a dynamic route this warms the route chunk and its loading
  // boundary rather than the page itself — the cruise hold covers the rest.
  useEffect(() => {
    router.prefetch(href);
  }, [router, href]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      // Let the browser handle anything that isn't a plain left-click:
      // cmd/ctrl-click still opens a tab, middle-click still works.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      launch(ref.current?.getBoundingClientRect() ?? null);
    },
    [launch, onClick],
  );

  return (
    <a
      ref={ref}
      href={href}
      className={className}
      onClick={handleClick}
      onPointerEnter={() => router.prefetch(href)}
      {...rest}
    >
      {children}
    </a>
  );
}
