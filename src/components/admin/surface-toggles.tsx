"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, HardHat, Lock } from "lucide-react";
import {
  setPreviewUnreleasedAction,
  setSurfaceHiddenAction,
  setViewAsUserAction,
} from "@/actions/admin";
import type { Surface } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

/**
 * One switch per surface (dashboard cards, widgets, settings sections).
 *
 * Optimistic on purpose, with a rollback: the toggle is the only feedback the operator
 * gets, and a switch that sits still for a round trip reads as a dead control. The
 * `router.refresh()` afterwards is what actually re-renders the admin page and the app
 * shell against the new flag — the local state only carries the gap. Pages have their own
 * three-state list (`PageStatusList`); everything here is simply shown or not.
 */
function SurfaceRow({ surface, hidden }: { surface: Surface; hidden: boolean }) {
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
    <li>
      <label
        className={cn(
          "flex items-center gap-4 py-2.5",
          locked ? "cursor-default" : "cursor-pointer"
        )}
      >
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm", isHidden && !locked && "text-muted-foreground")}>
            {surface.label}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {locked ? surface.reason : surface.description}
          </p>
          {error && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        {locked ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" aria-hidden />
            Always on
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                "w-14 text-right text-xs",
                isHidden ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {isHidden ? "Hidden" : "Visible"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={!isHidden}
              aria-label={`${isHidden ? "Show" : "Hide"} ${surface.label}`}
              disabled={pending}
              onClick={toggle}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors duration-fast disabled:opacity-60",
                isHidden ? "bg-muted-foreground/30" : "bg-primary"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow transition-transform duration-fast",
                  !isHidden && "translate-x-4"
                )}
              />
            </button>
          </span>
        )}
      </label>
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
        <SurfaceRow key={surface.key} surface={surface} hidden={hiddenSet.has(surface.key)} />
      ))}
    </ul>
  );
}

/** Puts back everything currently hidden, one write per surface. Reversible, so no confirm. */
export function UnhideAllButton({ hiddenKeys }: { hiddenKeys: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (hiddenKeys.length === 0) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              for (const key of hiddenKeys) {
                await setSurfaceHiddenAction({ surfaceKey: key, hidden: false });
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save that.");
            }
            router.refresh();
          })
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-60"
      >
        <EyeOff className="size-3" aria-hidden />
        {pending ? "Unhiding…" : `Unhide all ${hiddenKeys.length}`}
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Drops the operator's own exemption for this browser session and sends them into the app.
 *
 * `/dashboard` rather than back to the console: the point of the mode is to look at the
 * product, and the console is the one place it changes nothing.
 *
 * Entering redirects from inside `setViewAsUserAction` itself (one round trip instead of
 * awaiting the action here and then separately `router.push`ing — see that action's
 * comment). Exiting stays on this page, so it still needs its own `router.refresh()`.
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

/**
 * Opts the operator's own session past a coming-soon page (marked from the Pages list
 * below), which is closed to admins by default so an unreleased feature
 * cannot ship early just because whoever is building it is an admin.
 *
 * No redirect either direction — unlike `ViewAsUserButton`, turning this on or off does not
 * change what the caller can navigate to, only what an unreleased page shows once they are
 * there — so both directions just refresh in place.
 */
export function PreviewUnreleasedButton({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setPreviewUnreleasedAction({ on: !active });
          router.refresh();
        })
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
        active
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border/70 text-muted-foreground hover:text-foreground"
      )}
    >
      <HardHat className="size-3" aria-hidden />
      {active ? "Stop previewing unreleased pages" : "Preview unreleased pages"}
    </button>
  );
}
