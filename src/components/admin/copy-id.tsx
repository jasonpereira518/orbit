"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A Clerk user id, truncated for the table but copied in full.
 *
 * The displayed form is abbreviated because a `user_2abc…` id is thirty-odd characters of
 * noise that would dominate the row, but the *copied* value is always the whole id — a
 * half-copied identifier is worse than none, since it fails somewhere later rather than
 * here.
 *
 * `navigator.clipboard` is unavailable outside secure contexts, which includes plain-HTTP
 * LAN access to a dev server, so the older `execCommand` path stays as a fallback. It is
 * deprecated and it still works everywhere that matters.
 */
export function CopyId({
  value,
  label = "user ID",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Without this, unmounting the row mid-flash (a filter change, a page turn) leaves a
  // timer pointing at a dead component.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      ok = false;
    }

    if (!ok) ok = copyViaTextarea(value);
    if (!ok) return;

    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}: ${value}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 font-mono text-xs text-muted-foreground transition-colors duration-fast hover:bg-muted/60 hover:text-foreground",
        className
      )}
    >
      <span className="truncate">{truncateId(value)}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-primary" aria-hidden />
      ) : (
        <Copy
          className="size-3 shrink-0 opacity-0 transition-opacity duration-fast group-hover:opacity-100"
          aria-hidden
        />
      )}
      {/* Announced to screen readers; the icon swap alone is invisible to them. */}
      <span className="sr-only" role="status">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}

/** Keeps the `user_` prefix and the tail, which is the part that differs between accounts. */
function truncateId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 9)}…${value.slice(-4)}`;
}

function copyViaTextarea(value: string): boolean {
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    // Off-screen rather than `display: none` — a hidden element cannot be selected.
    el.style.position = "fixed";
    el.style.top = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
