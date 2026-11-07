"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/** Ops is a snapshot, not a poll: this re-renders the open tab on the server. */
export function OpsRefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-50"
    >
      <RefreshCw className={cn("size-3", pending && "animate-spin")} aria-hidden />
      {pending ? "Refreshing" : "Refresh"}
    </button>
  );
}
