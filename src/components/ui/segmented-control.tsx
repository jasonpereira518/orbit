"use client";

import { useId, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { IntentLink } from "@/components/ui/intent-link";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The one segmented control / tab strip.
 *
 * Seven hand-rolled `role="tablist"`s and two motion-pill tab components agreed on the idea
 * (a sliding pill under the selected label, from `people-list-shell.tsx`) and disagreed on
 * everything else: track colour, pill colour, whether arrow keys worked, whether panels were
 * announced. This is the single implementation. Items with an `href` render as links (route
 * tabs); the rest as buttons. Arrow keys move the selection; `aria-controls` points at the
 * matching `SegmentedPanel` when you give both the same `id`.
 *
 *   variant  "pill"    primary pill on a bordered card track (the default)
 *            "subtle"  muted pill on a muted track, for toolbars inside a card
 */
export type SegmentedItem<K extends string> = {
  key: K;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  href?: string;
  disabled?: boolean;
};

export function SegmentedControl<K extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  id,
  variant = "pill",
  size = "default",
  fill = false,
  className,
}: {
  items: SegmentedItem<K>[];
  value: K;
  onChange?: (key: K, item: SegmentedItem<K>) => void;
  ariaLabel: string;
  /** Pass the same id to `SegmentedPanel` so tabs and panels are wired for assistive tech. */
  id?: string;
  variant?: "pill" | "subtle";
  size?: "default" | "sm";
  /** Stretch items to fill the track (for two-option toggles). */
  fill?: boolean;
  className?: string;
}) {
  const auto = useId();
  const base = id ?? auto;
  const refs = useRef(new Map<K, HTMLElement>());

  function move(delta: 1 | -1) {
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.key === value);
    const next = enabled[(idx + delta + enabled.length) % enabled.length];
    if (!next) return;
    onChange?.(next.key, next);
    refs.current.get(next.key)?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  }

  const selectedClass = variant === "pill" ? "text-primary-foreground" : "text-ink";
  const pillClass = variant === "pill" ? "bg-primary shadow-sm" : "bg-card shadow-xs";

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex max-w-full shrink-0 overflow-x-auto rounded-lg p-0.5 whitespace-nowrap",
        fill ? "w-full" : "w-fit",
        variant === "pill" ? "border border-border-subtle bg-card" : "bg-muted",
        size === "sm" ? "text-xs" : "text-sm",
        className
      )}
    >
      {items.map((item) => {
        const selected = item.key === value;
        const common = {
          role: "tab" as const,
          id: `${base}-tab-${item.key}`,
          "aria-selected": selected,
          "aria-controls": `${base}-panel-${item.key}`,
          tabIndex: selected ? 0 : -1,
          "aria-disabled": item.disabled || undefined,
          className: cn(
            "relative z-10 flex items-center justify-center gap-1.5 rounded-md transition-colors duration-fast ease-house focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            size === "sm" ? "px-2.5 py-1" : "px-3 py-1.5",
            fill && "flex-1",
            selected ? selectedClass : "text-muted-foreground hover:text-foreground",
            item.disabled && "pointer-events-none opacity-50"
          ),
        };
        const inner = (
          <>
            {selected && (
              <motion.span
                layoutId={`${base}-pill`}
                className={cn("absolute inset-0 -z-10 rounded-md", pillClass)}
                transition={SPRING_PILL}
              />
            )}
            {item.icon && <span className="relative [&>svg]:size-3.5">{item.icon}</span>}
            <span className="relative">{item.label}</span>
            {typeof item.count === "number" && (
              <span
                className={cn(
                  "relative text-xs tabular-nums",
                  selected && variant === "pill" ? "text-primary-foreground/80" : "text-muted-foreground/80"
                )}
              >
                {item.count}
              </span>
            )}
          </>
        );
        if (item.href) {
          return (
            <IntentLink
              key={item.key}
              href={item.href}
              ref={(node) => {
                if (node) refs.current.set(item.key, node);
              }}
              onClick={(e) => {
                if (onChange) {
                  e.preventDefault();
                  if (!selected) onChange(item.key, item);
                }
              }}
              {...common}
            >
              {inner}
            </IntentLink>
          );
        }
        return (
          <button
            key={item.key}
            type="button"
            ref={(node) => {
              if (node) refs.current.set(item.key, node);
            }}
            onClick={() => {
              if (!selected) onChange?.(item.key, item);
            }}
            disabled={item.disabled}
            {...common}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedPanel<K extends string>({
  id,
  value,
  active,
  children,
  className,
  keepMounted = true,
}: {
  /** The `id` given to the matching `SegmentedControl`. */
  id: string;
  value: K;
  active: K;
  children: ReactNode;
  className?: string;
  /** Hide inactive panels instead of unmounting (keeps scroll and images). */
  keepMounted?: boolean;
}) {
  const hidden = value !== active;
  if (hidden && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${id}-panel-${value}`}
      aria-labelledby={`${id}-tab-${value}`}
      hidden={hidden}
      className={className}
    >
      {children}
    </div>
  );
}
