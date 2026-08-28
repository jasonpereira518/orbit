"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Lock } from "lucide-react";
import { setSurfaceHiddenAction, setViewAsUserAction } from "@/actions/admin";
import type { Surface } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

/**
 * One switch per surface.
 *
 * Optimistic on purpose, with a rollback: the toggle is the only feedback the operator
 * gets, and a switch that sits still for a round trip reads as a dead control. The
 * `router.refresh()` afterwards is what actually re-renders the admin page and the app
 * shell against the new flag — the local state only carries the gap.
 */
function SurfaceRow({
  surface,
  hidden,
}: {
  surface: Surface;
  hidden: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isHidden = optimistic ?? hidden;
  const locked = surface.alwaysVisible === true;

  function toggle() {
    const next = !isHidden;
    setOptimistic(next);
    setError(null);
    start(async () => {
      try {
        await setSurfaceHiddenAction({ surfaceKey: surface.key, hidden: next });
        router.refresh();
      } catch (err) {
        setOptimistic(null);
        setError(err instanceof Error ? err.message : "Could not save that.");
      }
    });
  }

  return (
    <li className="flex items-start gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "flex items-center gap-2 text-sm",
            isHidden && !locked && "text-muted-foreground"
          )}
        >
          {surface.label}
          {surface.href && (
            <code className="rounded bg-muted/60 px-1 text-[0.6875rem] text-muted-foreground">
              {surface.href}
            </code>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {locked ? surface.reason : surface.description}
        </p>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>

      {locked ? (
        <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          Always on
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={!isHidden}
          aria-label={`${isHidden ? "Show" : "Hide"} ${surface.label}`}
          disabled={pending}
          onClick={toggle}
          className={cn(
            "flex w-24 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
            isHidden
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border/70 text-muted-foreground hover:text-foreground"
          )}
        >
          {isHidden ? (
            <>
              <EyeOff className="size-3" aria-hidden />
              Hidden
            </>
          ) : (
            <>
              <Eye className="size-3" aria-hidden />
              Visible
            </>
          )}
        </button>
      )}
    </li>
  );
}

export function SurfaceToggles({
  surfaces,
  hidden,
}: {
  surfaces: Surface[];
  hidden: string[];
}) {
  const hiddenSet = new Set(hidden);
  return (
    <ul className="divide-y divide-border/50">
      {surfaces.map((surface) => (
        <SurfaceRow
          key={surface.key}
          surface={surface}
          hidden={hiddenSet.has(surface.key)}
        />
      ))}
    </ul>
  );
}

/**
 * Drops the operator's own exemption for this browser session and sends them into the app.
 *
 * `/dashboard` rather than back to the console: the point of the mode is to look at the
 * product, and the console is the one place it changes nothing.
 */
export function ViewAsUserButton({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setViewAsUserAction({ on: !active });
          if (active) router.refresh();
          else router.push("/dashboard");
        })
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/70 text-muted-foreground hover:text-foreground"
      )}
    >
      <Eye className="size-3" aria-hidden />
      {active ? "Stop viewing as a user" : "View as a general user"}
    </button>
  );
}
