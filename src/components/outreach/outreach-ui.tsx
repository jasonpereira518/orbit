"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const spring = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};
export const statusLabel = (s: string) => s.replaceAll("_", " ");
export const displayDate = (d: Date | null) =>
  d
    ? new Date(d).toLocaleString("en-US", {
        timeZone: "UTC",
        timeZoneName: "short",
      })
    : "Not checked yet";
export function Initials({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground"
    >
      {name
        .split(/\s+/)
        .slice(0, 2)
        .map((s) => s[0])
        .join("")}
    </span>
  );
}
export function Status({
  children,
  success = false,
}: {
  children: ReactNode;
  success?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground",
        success && "bg-success/10 text-success",
      )}
    >
      {success && <Check size={12} />}
      {children}
    </span>
  );
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <h2 className="font-heading text-2xl text-ink">{title}</h2>
      <div className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
export function ActionBar({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="sticky bottom-24 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-popover p-4 text-popover-foreground shadow-lg ring-1 ring-border"
    >
      {children}
    </motion.div>
  );
}
export function SplitView({
  list,
  children,
  active,
  onBack,
  label,
}: {
  list: ReactNode;
  children: ReactNode;
  active: boolean;
  onBack: () => void;
  label: string;
}) {
  const detail = useRef<HTMLDivElement>(null);
  const lastRow = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (active && window.matchMedia("(max-width: 1023px)").matches)
      detail.current?.focus({ preventScroll: true });
  }, [active]);
  return (
    <div className="grid min-w-0 overflow-hidden rounded-xl border bg-card lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2fr)]">
      <div
        onClickCapture={(e) => {
          const button = (e.target as HTMLElement).closest("button");
          if (button) lastRow.current = button;
        }}
        onKeyDown={(e) => {
          if (
            !(e.target instanceof HTMLButtonElement) ||
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
          )
            return;
          const rows = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
          );
          const i = rows.indexOf(e.target);
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? rows.length - 1
                : Math.max(
                    0,
                    Math.min(
                      rows.length - 1,
                      i + (e.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
          e.preventDefault();
          rows[next]?.focus();
        }}
        className={cn(
          "min-w-0 bg-muted/25 lg:block lg:max-h-[72vh] lg:overflow-y-auto lg:border-r",
          active && "hidden",
        )}
      >
        {list}
      </div>
      <div
        ref={detail}
        tabIndex={-1}
        aria-label={`${label} detail`}
        className={cn("min-w-0 outline-none lg:block", !active && "hidden")}
      >
        <div className="border-b px-3 py-2 lg:hidden">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onBack();
              requestAnimationFrame(() =>
                lastRow.current?.focus({ preventScroll: true }),
              );
            }}
          >
            <ArrowLeft size={15} />
            Back to {label}
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function ListRow({
  name,
  detail,
  trailing,
  active,
  onClick,
}: {
  name: string;
  detail: ReactNode;
  trailing?: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px]",
        active && "bg-accent/60",
      )}
    >
      <Initials name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {name}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {detail}
        </span>
        {trailing && <span className="mt-2 block">{trailing}</span>}
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}
