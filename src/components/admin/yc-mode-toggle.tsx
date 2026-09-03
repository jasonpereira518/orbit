"use client";

import { useTransition } from "react";
import { Rocket } from "lucide-react";
import { setYcModeAction } from "@/actions/admin";
import { cn } from "@/lib/utils";

/**
 * Full mode switch, not a per-item toggle — flipping it swaps which of `ADMIN_NAV` /
 * `ADMIN_YC_NAV` renders, so it has to navigate rather than just refresh in place.
 *
 * Unlike `ViewAsUserButton` in `surface-toggles.tsx`, the navigation happens inside
 * `setYcModeAction` itself via `redirect()` rather than a client-side `router.push()`
 * afterwards — one round trip instead of two. See that action's comment for why.
 */
export function YCModeToggle({ active }: { active: boolean }) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => setYcModeAction({ on: !active }))}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/70 text-muted-foreground hover:text-foreground"
      )}
    >
      <Rocket className="size-3" aria-hidden />
      {active ? "Exit YC mode" : "YC mode"}
    </button>
  );
}
