import { cn } from "@/lib/utils";

/**
 * The chip beside an example person's name. Muted on purpose: it labels, it does not
 * warn. The people it marks exist only while the guided tour is running.
 */
export function ExampleTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground",
        className,
      )}
      title="Added for the guided tour; removed when it ends"
    >
      Example
    </span>
  );
}
