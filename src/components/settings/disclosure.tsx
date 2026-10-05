"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A labelled block that starts collapsed — the "Advanced" shape this dialog already used by
 * hand in two places, extracted so a third and fourth copy is an import instead.
 *
 * The panel stays MOUNTED and is hidden with the `hidden` attribute. A panel that unmounts
 * leaves `aria-controls` pointing at an element that no longer exists, which is the defect a
 * previous phase fixed in this same dialog; keeping it mounted also means a field inside it
 * keeps whatever was typed when the block is closed and reopened.
 */
export function Disclosure({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className={cn("border-t border-border/60 pt-4", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 transition-transform duration-fast ease-house",
            open && "rotate-90"
          )}
        />
        {label}
      </button>
      <div id={panelId} hidden={!open} className="space-y-4 px-2.5 pt-2">
        {children}
      </div>
    </div>
  );
}
