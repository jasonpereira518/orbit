"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, HelpCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HELP_FAQ } from "@/components/help/help-faq";

/**
 * The FAQ alone, as `<details>`/`<summary>` cards — keyboard-operable and
 * usable without JS. Shared by the help sheet and Settings → Help so the
 * copy only lives in `help-faq.ts`.
 */
export function HelpFaqList() {
  return (
    <div className="space-y-2">
      {HELP_FAQ.map((item) => (
        <details
          key={item.q}
          className="group rounded-lg border border-border/60"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            {item.q}
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="space-y-3 border-t border-border/60 px-3 pb-3 pt-3">
            <p className="text-sm text-muted-foreground">{item.a}</p>
            {item.href && item.cta && (
              <Link
                href={item.href}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" })
                )}
              >
                {item.cta}
              </Link>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

/**
 * The `?` button plus its help sheet. Owns its own open state so it can be
 * mounted anywhere (sidebar footer, mobile "More" sheet) without the parent
 * having to wire anything up.
 *
 * `onBeforeOpen` runs synchronously on click, before the sheet opens — the
 * mobile "More" sheet uses it to close itself first rather than stacking a
 * second modal on top.
 */
export function HelpSheet({
  className,
  onBeforeOpen,
}: {
  className?: string;
  onBeforeOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={className}
        aria-label="Help"
        title="Help"
        onClick={() => {
          onBeforeOpen?.();
          setOpen(true);
        }}
      >
        <HelpCircle className="h-4 w-4" />
        <span className="hidden lg:inline">Help</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Help</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <HelpFaqList />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
