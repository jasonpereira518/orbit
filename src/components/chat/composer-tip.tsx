"use client";

import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The hover label for an icon-only composer button: what it is in bold, and what it does under it.
 *
 * These buttons used a native `title`, which shows after a long delay, in the OS's style, and
 * not at all on a keyboard focus. This is the app's own tooltip (the same one the sidebar and the
 * contact page's channel icons use), so it appears promptly on hover and on keyboard focus.
 * `trigger` is the button itself, without children; the icon goes in `children`.
 */
export function ComposerTip({
  label,
  hint,
  trigger,
  children,
}: {
  label: string;
  hint?: string;
  trigger: ReactElement;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
      <TooltipContent side="top">
        <span className="block font-medium">{label}</span>
        {hint ? <span className="block max-w-56 text-background/70">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
