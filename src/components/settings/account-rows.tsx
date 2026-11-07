"use client";

/** Rows the Google and Microsoft account pages share: a one-setting switch and the calendar picker. */

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FeatureRow } from "@/components/settings/account-page";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

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
