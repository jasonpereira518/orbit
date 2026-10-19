"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Lock, Search, Star } from "lucide-react";
import type { PublicRecruiter } from "@/lib/recruiters";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ROW_HOVER } from "@/lib/interaction";
import type { Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";

function formatAvg(avgRating: number) {
  if (!avgRating) return "—";
  return (avgRating / 10).toFixed(1);
}

/** Stored link status → chip. The stored values never change. */
function labelForLinkStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "contacted":
      return { label: "Contacted", tone: "info" };
    case "active":
      return { label: "Active", tone: "success" };
    case "archived":
      return { label: "Archived", tone: "neutral" };
    default:
      return { label: "Planned", tone: "neutral" };
  }
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
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        name="q"
        defaultValue={initialQ}
        placeholder="Search name, firm, specialty…"
        aria-label="Search recruiters"
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
  /** A noun phrase, no period: "No recruiters yet". */
  emptyMessage: string;
}) {
  if (!recruiters.length) {
    return <EmptyState variant="plain" title={emptyMessage} />;
  }

  return (
    <ul className="divide-y divide-border-subtle">
      {recruiters.map((r) => {
        const status = r.myLink ? labelForLinkStatus(r.myLink.status) : null;
        return (
          <li key={r.id}>
            <Link
              href={`/recruiters/${r.id}`}
              className={cn(
                "flex flex-wrap items-start justify-between gap-3 px-4 py-3 first:rounded-t-xl last:rounded-b-xl",
                ROW_HOVER
              )}
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{r.fullName}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {r.firm || "Unknown firm"}
                  {r.specialty.length
                    ? ` · ${r.specialty.slice(0, 3).join(", ")}`
                    : ""}
                </p>
                {status && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone={status.tone} size="sm">
                      {status.label}
                    </Badge>
                    {r.myLink?.sharedToPool === 0 && (
                      <Badge variant="outline" size="sm">
                        Kept private
                      </Badge>
                    )}
                  </div>
                )}
              </div>
              <div className="shrink-0 space-y-0.5 text-right text-xs text-muted-foreground">
                {/* Aggregates count pool-visible links only, so a recruiter only you have
                    logged legitimately reports zero. Saying so beats rendering "★ — (0)",
                    which reads as a bug rather than as "nobody else has rated them". */}
                {r.ratingCount > 0 ? (
                  <>
                    <p className="flex items-center justify-end gap-1">
                      <Star className="size-3 fill-current" aria-hidden />
                      {formatAvg(r.avgRating)}
                      <span className="text-muted-foreground/70">({r.ratingCount})</span>
                    </p>
                    <p>{r.logCount} logs</p>
                  </>
                ) : (
                  <p className="text-muted-foreground/70">No community ratings</p>
                )}
                {!r.piiUnlocked && (
                  <Badge tone="neutral" size="sm" className="ml-auto">
                    <Lock aria-hidden />
                    Contact locked
                  </Badge>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
