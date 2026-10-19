"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className={cn("border-t border-border-subtle pt-4", className)}>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="min-h-9 w-full justify-start text-muted-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 transition-transform duration-fast ease-house",
            open && "rotate-90"
          )}
        />
        {label}
      </Button>
      <div id={panelId} hidden={!open} className="space-y-4 px-2.5 pt-2">
        {children}
      </div>
    </div>
  );
}
