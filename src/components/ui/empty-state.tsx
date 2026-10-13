import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one empty state: a dashed box, an optional icon, a line saying what is missing, an
 * optional sentence of help and an optional action. The title is a `p`, not a heading — an
 * empty box should not add a section to the page outline.
 *
 * Not for dropzones: those are dashed too, but they are a target, not an absence.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center",
        className
      )}
    >
      {Icon && <Icon className="mx-auto size-8 text-muted-foreground" aria-hidden />}
      <p className={cn("font-medium text-ink", Icon && "mt-3")}>{title}</p>
      {description && (
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-3">{action}</div>}
    </div>
  );
}
