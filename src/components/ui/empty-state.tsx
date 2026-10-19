import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one empty state.
 *
 * Copy rule: `title` is a short noun phrase with no trailing period ("No reminders yet");
 * `description` is one full sentence with a period and says what to do; `action` is at most
 * one button or link. `variant="dashed"` is the in-page placeholder, `plain` the quiet
 * version for inside a card or a list, `card` a bordered box for a page-level empty.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "dashed",
  size = "default",
  titleAs: Title = "p",
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  variant?: "dashed" | "plain" | "card";
  size?: "default" | "sm";
  /** Heading level when the empty state is the section's only heading. */
  titleAs?: "p" | "h2" | "h3";
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center text-center",
        variant === "dashed" && "rounded-xl border border-dashed border-border-subtle",
        variant === "card" && "rounded-xl border border-border-subtle bg-card",
        size === "sm" ? "px-4 py-6" : "px-6 py-10",
        className
      )}
    >
      {Icon && (
        <span
          aria-hidden
          className={cn(
            "mb-3 flex items-center justify-center rounded-lg bg-muted text-muted-foreground",
            size === "sm" ? "size-8 [&>svg]:size-4" : "size-10 [&>svg]:size-5"
          )}
        >
          <Icon />
        </span>
      )}
      <Title className={cn("font-medium text-ink", size === "sm" ? "text-sm" : "text-base")}>{title}</Title>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
