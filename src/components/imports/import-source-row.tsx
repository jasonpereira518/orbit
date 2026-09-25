"use client";

import { type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One way into Orbit, collapsed to a line until someone opens it.
 *
 * This is what replaces the tab strip. Tabs existed for a good reason — five importers on one
 * page means five CSV parsers and five review tables on first paint — and collapsing keeps
 * that benefit while removing the part a non-technical reader had to learn, which was which
 * of three drawers their file belonged in.
 *
 * The collapsed `status` line is the whole point. A tab could not answer "is this set up?"
 * without being opened; a row answers it at rest.
 *
 * `open` is controlled by the parent so an account alert's deep link can open a row and mount
 * its panel in the same handler — `SectionFlash` only retries for two seconds, so a row that
 * mounted its child a tick later would miss the glow and the anchor would silently do nothing.
 */
export function ImportSourceRow({
  id,
  icon: Icon,
  accent,
  title,
  status,
  open,
  onOpenChange,
  children,
  disabled = false,
}: {
  /** The anchor an account alert can link at. Never rename one without updating the map. */
  id: string;
  icon: LucideIcon;
  accent: string;
  title: string;
  status: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <li
      id={id}
      className="scroll-mt-24 rounded-xl border border-border/60 bg-background/60"
    >
      <button
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left",
          "hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            accent,
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            {title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {status}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Rendered rather than height-animated: the panels inside mount lazily and can change
          height as they load, and an animated wrapper would fight that on every preview. */}
      {open ? (
        <div className="border-t border-border/60 p-4">{children}</div>
      ) : null}
    </li>
  );
}
