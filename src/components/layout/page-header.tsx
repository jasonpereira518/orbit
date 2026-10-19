import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { IntentLink } from "@/components/ui/intent-link";
import { cn } from "@/lib/utils";

/**
 * The one page header.
 *
 * Every page used to type its own `h1` block (four near-identical `*-header.tsx` files and
 * 17 inline copies, in five type sizes). This is the single shape: optional back link,
 * optional eyebrow, the title, an optional one-line description, and an actions slot that
 * wraps under the title on narrow screens instead of colliding with it.
 *
 * `loading/page-skeletons.tsx` exports `PageHeaderSkeleton` with the same box, so a page
 * that streams in does not move its title.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  back,
  reveal = true,
  as: Heading = "h1",
  className,
}: {
  title: ReactNode;
  /** Small label above the title ("Your network"). */
  eyebrow?: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  /** Buttons for the page; right-aligned, wraps below on phones. */
  actions?: ReactNode;
  /** A parent to return to. Renders above the title as "← {label}". */
  back?: { href: string; label: string };
  /** Entrance via `.reveal-mount` (off for headers inside a dialog or a streamed section). */
  reveal?: boolean;
  as?: "h1" | "h2";
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-3",
        reveal && "reveal-mount",
        className
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        {back && (
          <IntentLink
            href={back.href}
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {back.label}
          </IntentLink>
        )}
        {eyebrow && <p className="text-sm font-medium text-ink">{eyebrow}</p>}
        <Heading className="break-words font-heading text-3xl text-ink">{title}</Heading>
        {description && (
          <p className="max-w-2xl text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A titled block inside a page: h2 + optional description + optional action, then content.
 * Replaces the eight different section-heading styles the profile and events pages grew.
 */
export function PageSection({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("space-y-4", className)} aria-label={typeof title === "string" ? title : undefined}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="font-heading text-lg font-medium text-ink">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
