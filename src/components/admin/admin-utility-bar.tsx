"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { value: "1d", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
] as const;

export function AdminUtilityBar({ adminEmail }: { adminEmail?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [refreshedAt, setRefreshedAt] = useState(() => new Date());
  const reportWindow = params.get("window") ?? "7d";

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      startTransition(() => router.refresh());
      setRefreshedAt(new Date());
    }, 60_000);
    return () => globalThis.clearInterval(timer);
  }, [router]);

  const refresh = () => {
    startTransition(() => router.refresh());
    setRefreshedAt(new Date());
  };

  const setReportWindow = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("window", value);
    startTransition(() => router.replace(`${pathname}?${next.toString()}`));
  };

  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-border/70 bg-background/95 px-4 sm:px-6">
      <form action="/admin/users" className="relative min-w-0 max-w-xl flex-1" role="search">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          name="q"
          aria-label="Search accounts"
          placeholder="Search account email or user ID"
          className="h-9 w-full rounded-lg border border-border/70 bg-card pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </form>

      <label className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
        Window
        <select
          aria-label="Reporting window"
          value={reportWindow}
          onChange={(event) => setReportWindow(event.target.value)}
          className="h-8 rounded-lg border border-border/70 bg-card px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        >
          {WINDOWS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={refresh}
        disabled={isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw aria-hidden className={cn("size-3.5", isPending && "animate-spin")} />
        <span className="hidden sm:inline">
          {isPending
            ? "Refreshing"
            : `Updated ${refreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        </span>
      </button>

      <Link
        href="/dashboard"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground lg:hidden"
      >
        <span className="hidden sm:inline">Open app</span>
        <ArrowUpRight className="size-3.5" aria-hidden />
        <span className="sr-only sm:hidden">Open app</span>
      </Link>

      {adminEmail && (
        <span className="hidden max-w-48 truncate text-xs text-muted-foreground xl:block">
          {adminEmail}
        </span>
      )}
    </div>
  );
}
