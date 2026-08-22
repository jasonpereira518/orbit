/**
 * Static dashboard header, rendered by BOTH page.tsx and loading.tsx so
 * client navigation shows identical pixels before and after data arrives.
 */
export function DashboardHeader() {
  return (
    <header className="reveal-mount space-y-2">
      <p className="text-sm font-medium text-primary">Your network</p>
      <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary">
        Stay in orbit
      </h1>
      <p className="max-w-xl text-muted-foreground">
        Follow-ups, dormant connections, and people worth reaching out to — in one place.
        Press{" "}
        <kbd className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px]">
          ⌘K
        </kbd>{" "}
        to ask your network.
      </p>
    </header>
  );
}
