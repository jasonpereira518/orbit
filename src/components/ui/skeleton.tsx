import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      // Read by `src/lib/nav-timing.ts`: "no visible skeleton" is how page-load timing
      // knows a page has stopped being a placeholder. Keep it on every skeleton.
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
