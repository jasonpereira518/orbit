"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Search } from "lucide-react";
import type { PublicRecruiter } from "@/lib/recruiters";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function formatAvg(avgRating: number) {
  if (!avgRating) return "—";
  return (avgRating / 10).toFixed(1);
}

export function RecruiterSearch({
  initialQ,
  className,
}: {
  initialQ: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <form
      className={cn("relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const q = String(fd.get("q") || "").trim();
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        const tab = new URLSearchParams(window.location.search).get("tab");
        if (tab) params.set("tab", tab);
        start(() => {
          router.push(
            `/recruiters${params.toString() ? `?${params}` : ""}`
          );
        });
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        name="q"
        defaultValue={initialQ}
        placeholder="Search name, firm, specialty…"
        className="pl-9"
        disabled={pending}
      />
    </form>
  );
}

export function RecruiterList({
  recruiters,
  emptyMessage,
}: {
  recruiters: PublicRecruiter[];
  emptyMessage: string;
}) {
  if (!recruiters.length) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border/60">
      {recruiters.map((r) => (
        <li key={r.id}>
          <Link
            href={`/recruiters/${r.id}`}
            className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 transition-colors hover:bg-muted/40"
          >
            <div className="min-w-0">
              <p className="font-medium text-primary">{r.fullName}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {r.firm || "Unknown firm"}
                {r.specialty.length
                  ? ` · ${r.specialty.slice(0, 3).join(", ")}`
                  : ""}
              </p>
              {r.myLink && (
                <Badge variant="secondary" className="mt-2 text-[10px]">
                  {r.myLink.status}
                </Badge>
              )}
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>
                ★ {formatAvg(r.avgRating)}
                <span className="text-muted-foreground/70">
                  {" "}
                  ({r.ratingCount})
                </span>
              </p>
              <p className="mt-0.5">{r.logCount} logs</p>
              {!r.piiUnlocked && (
                <p className="mt-1 text-[10px] uppercase tracking-wide">
                  Contact locked
                </p>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
