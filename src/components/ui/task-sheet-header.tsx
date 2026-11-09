"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

/** Long tasks keep their name and exit reachable while the body scrolls. */
export function TaskSheetHeader({ title, description, onClose, disabled = false }: { title: ReactNode; description?: ReactNode; onClose: () => void; disabled?: boolean }) {
  return (
    <SheetHeader className="sticky top-0 z-20 min-h-16 shrink-0 border-b border-border/60 bg-popover pr-16">
      <SheetTitle>{title}</SheetTitle>
      {description && <SheetDescription>{description}</SheetDescription>}
      <Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3 size-11" aria-label="Close" onClick={onClose} disabled={disabled}><X aria-hidden className="size-4" /></Button>
    </SheetHeader>
  );
}
