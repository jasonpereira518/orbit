import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The back link above a page title. Exported for the two heroes (contact profile, event)
 * that draw their own title but should still lead back the same way every other page does.
 */
export const BACK_LINK =
  "mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

/**
 * The one page header for every page inside the app shell: optional back link and eyebrow,
 * the Fraunces title, a muted subtitle, actions to the right and an optional toolbar row
 * below. Server-safe (no hooks) so client pages can render it too.
 *
 * `size="lg"` is the dashboard's alone: it is the landing page and keeps the larger title.
 * `compact` hides the subtitle below md, for viewport-locked pages (chat, graph) where a
 * wrapped line costs the canvas its height.
 *
 * `loading.tsx` files draw `PageHeaderSkeleton` from `@/components/loading/page-skeletons`,
 * which tracks this geometry.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  back,
  size = "md",
  compact = false,
  children,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  size?: "md" | "lg";
  compact?: boolean;
  /** A toolbar row under the title, e.g. a search form. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "reveal-mount flex shrink-0 flex-wrap items-start justify-between gap-4",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        {back && (
          <Link href={back.href} className={BACK_LINK}>
            <ArrowLeft className="size-3.5" aria-hidden />
            {back.label}
          </Link>
        )}
        {eyebrow && <p className="mb-1 text-sm font-medium text-ink">{eyebrow}</p>}
        <h1
          className={cn(
            "font-[family-name:var(--font-display)] text-ink",
            size === "lg" ? "text-4xl tracking-tight" : "text-3xl"
          )}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className={cn(
              "mt-1 max-w-2xl text-muted-foreground",
              compact && "hidden md:block"
            )}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      {children && (
        <div className="flex min-h-10 w-full flex-wrap items-center gap-2">{children}</div>
      )}
    </header>
  );
}
