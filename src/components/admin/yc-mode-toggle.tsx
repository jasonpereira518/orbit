"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { setYcModeAction } from "@/actions/admin";
import { cn } from "@/lib/utils";

/**
 * Full mode switch, not a per-item toggle — flipping it swaps which of `ADMIN_NAV` /
 * `ADMIN_YC_NAV` renders, so it has to navigate rather than just refresh in place.
 * Follows `ViewAsUserButton`'s push-to-the-right-route pattern in `surface-toggles.tsx`.
 */
export function YCModeToggle({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setYcModeAction({ on: !active });
          router.push(active ? "/admin" : "/admin/yc");
        })
      }
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
