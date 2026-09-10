"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshProvidersAction } from "@/actions/admin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function ProviderRefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => {
        try {
          await refreshProvidersAction();
          toast.success("Provider checks refreshed.");
          router.refresh();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Provider checks failed.");
        }
      })}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
    >
      <RefreshCw className={cn("size-3", pending && "animate-spin")} aria-hidden />
      {pending ? "Checking" : "Check now"}
    </button>
  );
}
