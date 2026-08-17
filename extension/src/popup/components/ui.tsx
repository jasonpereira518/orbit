/**
 * The handful of primitives this panel needs, matching the app's look.
 *
 * Ported rather than imported: the app's components come from shadcn on Base
 * UI and live in the Next project's module graph. ~100 lines of intentional
 * duplication beats building a shared UI package for one consumer.
 * Source: src/components/ui/{button,input,textarea,badge,skeleton}.tsx
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost" | "subtle";
  size?: "sm" | "md";
};

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium",
        "transition-colors disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "default" &&
          "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90",
        variant === "outline" &&
          "border border-[var(--border)] bg-transparent hover:bg-[var(--accent)]",
        variant === "ghost" && "bg-transparent hover:bg-[var(--accent)]",
        variant === "subtle" &&
          "bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--accent)]",
        className
      )}
    />
  );
}

export function Badge({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "primary" | "danger";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "muted" && "bg-[var(--muted)] text-[var(--muted-foreground)]",
        tone === "primary" && "bg-[var(--accent)] text-[var(--primary)]",
        tone === "danger" &&
          "bg-[var(--destructive)]/12 text-[var(--destructive)]",
        className
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[calc(var(--radius)*0.6)] bg-[var(--muted)]",
        className
      )}
    />
  );
}

export function Avatar({
  src,
  name,
  size = 40,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
}) {
  return (
    <div
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)] text-[var(--primary)]"
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span
          className="font-medium"
          style={{ fontSize: Math.max(11, size * 0.34) }}
        >
          {initials(name)}
        </span>
      )}
    </div>
  );
}

export function Section({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("px-4 py-3", className)}>
      {title ? (
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}
