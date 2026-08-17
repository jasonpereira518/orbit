import type { PageContext } from "@contract";
import { pageDisplayName, pageSubtitle, siteLabel } from "@/lib/page";
import { Avatar, Badge, Skeleton } from "./ui";

/**
 * Painted from the local page read, before any network call — this is the
 * "instantly useful" promise, and it stays on screen through every other state
 * including offline, because it costs nothing.
 */
export function PageContextStrip({
  page,
  trailing,
}: {
  page: PageContext | null;
  trailing?: React.ReactNode;
}) {
  if (!page) {
    return (
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
      </div>
    );
  }

  const name = pageDisplayName(page);
  const subtitle = pageSubtitle(page);

  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
      <Avatar src={page.identity.photoUrl?.value} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[15px] font-medium leading-tight">
            {name ?? "This page"}
          </p>
          <Badge>{siteLabel(page)}</Badge>
        </div>
        {subtitle ? (
          <p className="mt-0.5 truncate text-[12px] text-[var(--muted-foreground)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {trailing}
    </div>
  );
}
