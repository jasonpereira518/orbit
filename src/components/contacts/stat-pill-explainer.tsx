"use client";

import { badgeVariants } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A stat pill that explains itself on tap. A popover rather than a `title`, so the
 * explanation reaches touch screens too. Closeness and Health sit side by side and both
 * read as "how are we doing" at a glance — saying what each one measures is the fix.
 */
export function StatPillExplainer({
  label,
  className,
  title,
  body,
  children,
}: {
  /** Accessible name of the trigger, the full sentence a screen reader should hear. */
  label: string;
  className?: string;
  title: string;
  body: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          badgeVariants({ variant: "secondary" }),
          "cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-shadow hover:ring-1 hover:ring-foreground/15",
          className
        )}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-72 space-y-2 text-xs leading-relaxed">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {body}
      </PopoverContent>
    </Popover>
  );
}
