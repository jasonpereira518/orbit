import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The content column every page shares.
 *
 * `app-shell.tsx` already fixes the outer gutter (`max-w-6xl px-4 md:px-10 py-6 md:py-8`);
 * pages then narrowed it with five different `max-w-*` values and one re-added its own
 * padding. These four widths are the whole menu:
 *
 *   narrow   forms and settings                    max-w-2xl
 *   default  reading pages (capture, imports …)    max-w-3xl
 *   wide     grids and tables (events, radar …)    max-w-5xl
 *   full     the shell's own width (chat, graph)   none
 *
 * Vertical rhythm is `space-y-8` between header and sections; a section keeps its own
 * `space-y-4` inside.
 */
const WIDTH = {
  narrow: "max-w-2xl",
  default: "max-w-3xl",
  wide: "max-w-5xl",
  full: "",
} as const;

export type PageWidth = keyof typeof WIDTH;

export function PageShell({
  width = "default",
  spacing = "default",
  children,
  className,
}: {
  width?: PageWidth;
  /** `tight` for pages whose first child is a toolbar rather than a section. */
  spacing?: "default" | "tight";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-page-width={width}
      className={cn(
        WIDTH[width],
        spacing === "tight" ? "space-y-6" : "space-y-8",
        className
      )}
    >
      {children}
    </div>
  );
}
