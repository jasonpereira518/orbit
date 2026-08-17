/**
 * The panel shell.
 *
 * Content arrives in three staged commits (local DOM ~40ms, /resolve ~400ms,
 * AI starters 1–3s) and the panel persists across navigation. Height stability
 * therefore has to be a property of the shell, not a discipline applied per
 * component — so the two zones that are always present have fixed heights and
 * everything network-dependent lands inside the scroll region below them.
 *
 *   IDENTITY   fixed   painted at t≈40ms, never re-heights
 *   VERDICT    fixed   the one line: do I know this person
 *   scroll     flex-1  everything else
 *   COMPOSER   0↔auto  only on user action
 *   ACTIONS    fixed
 */
import type { ReactNode } from "react";
import { ExternalLink, Settings } from "lucide-react";
import type { PageContext } from "@contract";
import { cn } from "@/lib/cn";
import { APP_URL } from "@/lib/env";
import { pageDisplayName, pageSubtitle, siteLabel } from "@/lib/page";
import { Avatar, CompanyMark, Skeleton } from "./ui";
import { SealRing } from "./orbit";

export function PanelHeader({ onSettings }: { onSettings?: () => void }) {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-3 py-2">
      {/* Fraunces moment 1 of 2. */}
      <span
        className="text-[15px] leading-none"
        style={{ fontFamily: "var(--font-display), Georgia, serif", fontWeight: 500 }}
      >
        Orbit
      </span>
      <span className="flex items-center gap-0.5">
        {onSettings ? (
          <button
            onClick={onSettings}
            title="Panel settings"
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
          >
            <Settings size={13} />
          </button>
        ) : null}
        <button
          onClick={() => chrome.tabs.create({ url: `${APP_URL}/dashboard` })}
          title="Open Orbit"
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
        >
          <ExternalLink size={13} />
        </button>
      </span>
    </header>
  );
}

/**
 * Who the page is about. Painted from the local DOM read, so it is on screen
 * before any request finishes — and it survives every failure below it, which
 * is why an offline or signed-out panel still proves the extension works.
 */
export function IdentityZone({
  page,
  sealed,
  stale,
}: {
  page: PageContext | null;
  sealed?: boolean;
  stale?: boolean;
}) {
  if (!page) {
    return (
      <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-3 py-2.5">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-2.5 w-40" />
        </div>
      </div>
    );
  }

  const name = pageDisplayName(page);
  const subtitle = pageSubtitle(page);
  const company = page.identity.company?.value ?? null;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-3 py-2.5 transition-opacity",
        stale && "opacity-60"
      )}
    >
      <span className="relative inline-flex h-9 w-9 shrink-0">
        <Avatar src={page.identity.photoUrl?.value} name={name} size={36} />
        <SealRing size={36} drawn={Boolean(sealed)} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium leading-[18px]">
          {name ?? "This page"}
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
          {company ? (
            <CompanyMark company={company} className="min-w-0" />
          ) : subtitle ? (
            <span className="truncate">{subtitle}</span>
          ) : null}
        </div>
      </div>
      <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
        {siteLabel(page)}
      </span>
    </div>
  );
}

/**
 * The one-line answer to "do I know this person", always in the same place at
 * the same height. Everything transient — offline, errors, held drafts, lost
 * read access — takes over this band rather than pushing the layout around.
 */
export function VerdictZone({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "accent" | "alert";
}) {
  return (
    <div
      className={cn(
        "flex min-h-[34px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px]",
        tone === "accent" && "bg-[var(--accent)]",
        tone === "alert" && "bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)]"
      )}
    >
      {children}
    </div>
  );
}

export function VerdictSkeleton() {
  return (
    <VerdictZone>
      <Skeleton className="h-2.5 w-36" />
    </VerdictZone>
  );
}
