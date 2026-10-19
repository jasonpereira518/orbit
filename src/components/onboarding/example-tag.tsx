import { Badge } from "@/components/ui/badge";

/**
 * The chip beside an example person's name. Muted on purpose: it labels, it does not
 * warn. The people it marks exist only while the guided tour is running.
 */
export function ExampleTag({ className }: { className?: string }) {
  return (
    <Badge
      tone="neutral"
      size="sm"
      className={className}
      title="Added for the guided tour; removed when it ends"
    >
      Example
    </Badge>
  );
}
