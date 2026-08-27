import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Server-rendered pager. No client state: every control is a `<Link>` carrying the current
 * query string with `page` swapped, so paging survives a reload and is linkable — which is
 * what you want when the thing you are looking at is an account you need to send someone.
 */
export function Pager({
  page,
  pageCount,
  total,
  pageSize,
  hrefFor,
  label = "accounts",
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  hrefFor: (page: number) => string;
  label?: string;
}) {
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const step = (target: number, text: string, disabled: boolean) =>
    disabled ? (
      <span className="cursor-default px-2 py-1 text-muted-foreground/40" aria-disabled>
        {text}
      </span>
    ) : (
      <Link
        href={hrefFor(target)}
        className="px-2 py-1 text-muted-foreground transition-colors duration-fast hover:text-primary"
      >
        {text}
      </Link>
    );

  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border/40 pt-3 text-xs"
      )}
    >
      <p className="text-muted-foreground tabular-nums">
        {first}–{last} of {total} {label}
      </p>

      {pageCount > 1 && (
        <nav className="flex items-center gap-1" aria-label="Pagination">
          {step(1, "« First", page <= 1)}
          {step(page - 1, "‹ Prev", page <= 1)}
          <span className="px-2 py-1 tabular-nums text-muted-foreground">
            {page} / {pageCount}
          </span>
          {step(page + 1, "Next ›", page >= pageCount)}
          {step(pageCount, "Last »", page >= pageCount)}
        </nav>
      )}
    </div>
  );
}
