"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WarpLink } from "@/components/warp/warp-link";
import { flashSection } from "@/components/layout/section-flash";
import { cn } from "@/lib/utils";
import {
  ALERTS_COLLAPSED_VISIBLE,
  type AccountAlert,
} from "@/lib/account-alerts";
import { dismissAlert, loadActiveDismissals } from "@/lib/alert-dismissals";

/**
 * Account health, pinned to the foot of the notifications panel.
 *
 * Sits below the list rather than in it, and deliberately does NOT borrow the shape of a
 * `NotificationRow` — same rule the extension promo follows. A reminder is something you
 * finish; an alert is a statement about the account that stays true until you fix it, so
 * it gets a tinted strip and a single link rather than a card with Done and Snooze.
 *
 * Whether a row can be hidden comes from `alert.dismissible`, NOT from its severity — see
 * `DISMISSIBLE_CODES` in `@/lib/account-alerts`. A failed import is an error you may hide
 * (it already happened); an overdue card is a warning you may not (hiding it is how you
 * lose Orbit Pro without noticing). Hiding is a week-long snooze rather than a permanent
 * dismissal; `@/lib/alert-dismissals` explains why.
 */
export function AccountAlerts({
  alerts,
  onNavigate,
  className,
}: {
  alerts: AccountAlert[];
  onNavigate: () => void;
  /** Supplied by the panel: the pinned block's own padding, border and height cap. */
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Read once at mount, like the extension promo's own dismissal, so a warning the user
  // already hid never flashes back for a frame.
  const [dismissed, setDismissed] = useState(loadActiveDismissals);

  // A non-dismissible alert is never filtered, however stale a stored record might be —
  // the flag is re-evaluated server-side on every poll, so a code that stops being
  // dismissible immediately starts ignoring any dismissal already on this device.
  const live = alerts.filter((a) => !a.dismissible || !dismissed.has(a.id));
  if (live.length === 0) return null;

  const collapsible = live.length > ALERTS_COLLAPSED_VISIBLE;
  // Derived rather than stored, so a list that shrinks between polls (the user fixed
  // something) self-corrects without an effect and cannot strand `expanded` on a
  // toggle that is no longer rendered.
  const showAll = expanded && collapsible;
  const visible = showAll ? live : live.slice(0, ALERTS_COLLAPSED_VISIBLE);
  const hiddenCount = live.length - visible.length;

  // Keeps the shape of the panel's own `Section` helper — heading, count, stack of rows —
  // so that being pinned reads as "this section sits at the bottom" rather than as a
  // different kind of thing bolted on. The padding, border and height cap belong to the
  // panel, which is the only place that knows what it is being pinned against.
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between px-0.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Alerts
        </h3>
        <span className="text-xs text-muted-foreground">{live.length}</span>
      </div>

      <div className="space-y-1.5">
        {visible.map((alert) => (
          <AlertRow
            key={alert.id}
            alert={alert}
            onNavigate={onNavigate}
            onDismiss={
              alert.dismissible
                ? () => setDismissed(dismissAlert(alert.id))
                : undefined
            }
          />
        ))}
      </div>

      {collapsible && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-full justify-center text-xs text-muted-foreground"
          aria-expanded={showAll}
          onClick={() => setExpanded((v) => !v)}
        >
          {showAll ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              {hiddenCount} more
            </>
          )}
        </Button>
      )}
    </section>
  );
}

/**
 * One line. The link fills it; the dismiss button, when there is one, sits BESIDE the link
 * rather than inside it — an interactive element nested in an anchor is invalid, and in
 * practice the click would land on whichever the browser felt like.
 *
 * The row used to carry the body copy and a separate text CTA, which made a single alert
 * about four lines tall and pushed the reminder list off the panel. The body survives as
 * the `title` attribute rather than being dropped outright, and the destination page
 * carries the detail anyway — the import alert links to the import that failed.
 */
function AlertRow({
  alert,
  onNavigate,
  onDismiss,
}: {
  alert: AccountAlert;
  onNavigate: () => void;
  onDismiss?: () => void;
}) {
  const isError = alert.severity === "error";
  const Icon = isError ? AlertCircle : AlertTriangle;

  const shell = cn(
    "flex items-center rounded-lg border text-sm transition-colors",
    isError
      ? "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
      : "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400"
  );
  const body = cn(
    "flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-left",
    onDismiss ? "pr-1" : "pr-2.5"
  );

  const inner = (
    <>
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">{alert.title}</span>
      {alert.cta && <ChevronRight className="size-3.5 shrink-0 opacity-60" />}
    </>
  );

  // Body as the tooltip, so the detail the row no longer shows is still reachable.
  const title = alert.body ?? undefined;

  // Close the panel AND name the card to glow. Asking explicitly rather than leaving
  // `SectionFlash` to infer it from the URL is what makes this work when the target is on
  // the page the reader is already looking at — no route or hash change to react to.
  const target = alert.cta?.href.split("#")[1] ?? "";
  const go = () => {
    onNavigate();
    if (target) flashSection(target);
  };

  return (
    <div className={shell}>
      {alert.cta ? (
        // `WarpLink` runs `onClick` before deciding to intercept and bails on
        // `defaultPrevented`, so closing the sheet here cannot swallow the navigation.
        alert.cta.external ? (
          <WarpLink
            href={alert.cta.href}
            className={body}
            title={title}
            onClick={go}
          >
            {inner}
          </WarpLink>
        ) : (
          <Link
            href={alert.cta.href}
            className={body}
            title={title}
            onClick={go}
          >
            {inner}
          </Link>
        )
      ) : (
        <div className={body} title={title}>
          {inner}
        </div>
      )}

      {onDismiss && (
        <button
          type="button"
          // Names the alert, so a screen reader reaching a row of these can tell the
          // dismiss buttons apart.
          aria-label={`Dismiss: ${alert.title}`}
          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:opacity-100"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
