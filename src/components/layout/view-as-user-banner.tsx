"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import { setViewAsUserAction } from "@/actions/admin";

/**
 * The bar an operator sees while previewing Orbit as an ordinary user.
 *
 * Deliberately loud and deliberately in the layout flow rather than floating: this mode
 * removes the viewer's own access to hidden surfaces, so an operator who forgets they are
 * in it will read a working product as a broken one. A dismissible corner pill would be
 * exactly the wrong shape for that.
 *
 * `router.refresh()` after exiting, not just the action's `revalidatePath`: the cookie
 * changed, so every server component above needs to re-run against the new visibility.
 */
export function ViewAsUserBanner({ hiddenCount }: { hiddenCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="flex shrink-0 items-center justify-center gap-3 bg-primary px-4 py-1.5 text-xs text-primary-foreground">
      <Eye className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 truncate">
        <span className="font-medium">Viewing as a general user</span>
        <span className="hidden sm:inline">
          {" · "}
          {hiddenCount === 0
            ? "nothing is hidden right now"
            : `${hiddenCount} surface${hiddenCount === 1 ? "" : "s"} hidden`}
        </span>
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await setViewAsUserAction({ on: false });
            router.refresh();
          })
        }
        className="flex shrink-0 items-center gap-1 rounded-full bg-primary-foreground/15 px-2 py-0.5 font-medium transition-colors hover:bg-primary-foreground/25 disabled:opacity-60"
      >
        <X className="size-3" aria-hidden />
        {pending ? "Exiting…" : "Exit"}
      </button>
    </div>
  );
}
