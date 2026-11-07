"use client";

/** Rows the Google and Microsoft account pages share: a one-setting switch and the calendar picker. */

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureRow } from "@/components/settings/account-page";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

/**
 * Sync now for an account page: run `start` (an action that answers), then re-read with
 * `refresh` every two seconds until the last-synced time moves past the click, or a minute
 * has gone by. `syncing` covers both the call and the wait.
 */
export function useSyncNow(
  start: () => Promise<{ ok: true } | { ok: false; error: string }>,
  lastSyncedAt: string | Date | null | undefined,
  refresh: () => void
) {
  const [pending, run] = useTransition();
  const [since, setSince] = useState<number | null>(null);
  const last = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;
  const waiting = since !== null && last < since;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (Date.now() - since > 60_000) setSince(null);
      else refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, since, refresh]);
  return {
    syncing: pending || waiting,
    sync: () =>
      run(async () => {
        try {
          const result = await start();
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          setSince(Date.now());
        } catch (err) {
          toast.error(friendlyError(err, "Couldn’t start a sync — try again?"));
        }
      }),
  };
}

/**
 * One number at a glance: a small label, the value, one short line under it, and room for a
 * bar or a button. `value` undefined is still loading; null is a source that failed.
 */
export function StatTile({
  label,
  value,
  sub,
  title,
  children,
}: {
  label: string;
  value: React.ReactNode | null | undefined;
  sub?: React.ReactNode;
  /** The longer story behind the tile — a reset date, the full model name. */
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div title={title} className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      {value === undefined ? (
        <Skeleton className="my-1 h-6 w-16" />
      ) : (
        <p className="truncate font-heading text-xl text-ink tabular-nums">{value ?? "—"}</p>
      )}
      <p className="truncate text-xs text-muted-foreground">{value === null ? "Unavailable" : sub}</p>
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </div>
  );
}

/**
 * One choice of a few, side by side: LinkedIn's refresh interval, Granola's which-notes, the
 * Assistants page's Claude or ChatGPT. A radiogroup, filled in the page's `--primary`.
 */
export function SegmentedControl<T extends string | number | boolean>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  /** Names the group for screen readers. */
  label: string;
  options: readonly { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl bg-muted/60 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => value !== o.value && onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium outline-none transition-colors duration-fast ease-house focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
            value === o.value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A row whose whole job is one setting. `save` answers like the actions here do (an
 * `ActionResult` whose refusal is shown verbatim), and the page re-reads on success.
 */
export function SwitchRow({
  icon,
  tone,
  title,
  description,
  on,
  busy,
  save,
  done,
  onSaved,
}: {
  icon: React.ReactNode;
  tone: string;
  title: string;
  description: React.ReactNode;
  on: boolean;
  busy: boolean;
  save: (on: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  done: (on: boolean) => string;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  return (
    <FeatureRow
      icon={icon}
      tone={tone}
      title={title}
      description={description}
      control={{ kind: "switch", on }}
      disabled={busy || pending}
      onAction={() =>
        start(async () => {
          try {
            const result = await save(!on);
            if (!result.ok) {
              toast.error(result.error);
              return;
            }
            toast.success(done(!on));
            onSaved();
          } catch (err) {
            toast.error(friendlyError(err, TOAST_COPY.saveFailed));
          }
        })
      }
    />
  );
}

export type CalendarPickerRow = { id: string; name: string; color: string | null; enabled: boolean; primary: boolean };

/**
 * Which calendars meetings come from. Only the main one until the person asks the provider
 * for the rest ("Show my other calendars"); new ones start off, since reading more of
 * someone's calendars is their call.
 */
export function CalendarPicker({
  calendars,
  tone,
  primaryLabel,
  setEnabled,
  refreshList,
  onChanged,
}: {
  calendars: CalendarPickerRow[];
  /** The dot for a calendar the provider gives no colour. */
  tone: string;
  /** "Primary" (Google) or "Default" (Outlook). */
  primaryLabel: string;
  setEnabled: (id: string, on: boolean) => Promise<unknown>;
  refreshList: () => Promise<unknown>;
  onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      try {
        await fn();
        onChanged();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Calendars</p>
      {calendars.length ? (
        <ul className="space-y-1.5">
          {calendars.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={c.enabled} disabled={pending} onCheckedChange={(on) => run(() => setEnabled(c.id, on))} />
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? tone }} />
                <span className="min-w-0 truncate">{c.name}</span>
                {c.primary ? <span className="text-xs text-muted-foreground">{primaryLabel}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Your {primaryLabel.toLowerCase()} calendar.</p>
      )}
      <Button variant="ghost" size="sm" className="-ml-2" disabled={pending} onClick={() => run(refreshList)}>
        {calendars.length > 1 ? "Refresh calendar list" : "Show my other calendars"}
      </Button>
    </div>
  );
}
