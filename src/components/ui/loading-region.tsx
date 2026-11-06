import { cn } from "@/lib/utils"

/**
 * The live region around a page or panel skeleton. Sighted users see the shimmer; this is
 * what tells a screen reader the page is loading instead of leaving it silent. Skeleton
 * blocks inside are `aria-hidden` (see `ui/skeleton.tsx`).
 */
export function LoadingRegion({
  label = "Loading",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-slot="loading-region"
      className={cn(className)}
      {...props}
    >
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  )
}
