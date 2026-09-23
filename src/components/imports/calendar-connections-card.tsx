"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  Check,
  Link2,
  Loader2,
  PauseCircle,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { startGmailOAuth } from "@/actions/gmail";
import { startOutlookOAuth } from "@/actions/outlook";
import {
  removeCalendarSubscription,
  syncCalendarSubscriptionNow,
  updateCalendarSubscription,
} from "@/actions/calendar";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import type {
  CalendarSource,
  CalendarSourceState,
} from "@/lib/imports/calendar-sources";
import { cn } from "@/lib/utils";

/**
 * Every calendar Orbit watches, as one list.
 *
 * Three mechanisms sit behind these rows — two cursored OAuth syncs and a link on a staleness
 * clock — and nothing in a row says which. A person has calendars; how Orbit reaches them is
 * Orbit's problem. The only places the difference shows are the two where it must: adding one,
 * and fixing one.
 */

const STATE_BADGE: Record<
  CalendarSourceState,
  { label: string; tone: string } | null
> = {
  on: null,
  syncing: { label: "Checking", tone: "text-muted-foreground" },
  paused: { label: "Paused", tone: "text-muted-foreground" },
  needs_permission: { label: "Off", tone: "text-muted-foreground" },
  needs_reconnect: { label: "Needs you", tone: "text-destructive" },
  trouble: { label: "Needs you", tone: "text-destructive" },
};

export function CalendarConnectionsCard({
  sources,
  googleConfigured,
  outlookConfigured,
  onAddLink,
}: {
  sources: CalendarSource[];
  googleConfigured: boolean;
  outlookConfigured: boolean;
  onAddLink: () => void;
}) {
  const [busy, start] = useTransition();

  function connect(kind: "google" | "outlook") {
    start(async () => {
      try {
        // Per-purpose consent: this asks for the calendar scope and nothing else, so someone
        // who only wanted contacts is not re-asked for everything.
        const { url } =
          kind === "google"
            ? await startGmailOAuth({
                purpose: "calendar",
                returnTo: "/imports",
              })
            : await startOutlookOAuth({
                purpose: "calendar",
                returnTo: "/imports",
              });
        window.location.href = url;
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.connectFailed));
      }
    });
  }

  return (
    <div className="space-y-4">
      {sources.length ? (
        <ul className="space-y-2">
          {sources.map((source) => (
            <CalendarRow
              key={`${source.kind}-${source.id}`}
              source={source}
              busy={busy}
              onFix={() =>
                source.kind === "link" ? onAddLink() : connect(source.kind)
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing syncing yet — add a calendar and Orbit logs your meetings as
          they happen
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Add a calendar
        </span>
        {googleConfigured ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => connect("google")}
          >
            Google Calendar
          </Button>
        ) : null}
        {outlookConfigured ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => connect("outlook")}
          >
            Outlook or Microsoft 365
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onAddLink}>
          <Link2 className="size-3.5" />
          Any other calendar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Apple, Fastmail, Notion, or a work calendar — anything that can share a
        link
      </p>
    </div>
  );
}

function CalendarRow({
  source,
  busy,
  onFix,
}: {
  source: CalendarSource;
  busy: boolean;
  onFix: () => void;
}) {
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  const badge = STATE_BADGE[source.state];
  const needsAttention =
    source.state === "needs_reconnect" || source.state === "trouble";

  if (gone) return null;

  function run(work: () => Promise<unknown>, fallback: string) {
    start(async () => {
      try {
        await work();
      } catch (err) {
        toast.error(friendlyError(err, fallback));
      }
    });
  }

  return (
    <li className="flex items-center gap-3 rounded-xl border border-border/60 px-4 py-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          needsAttention
            ? "bg-destructive/10 text-destructive"
            : "bg-import-calendar/10 text-import-calendar",
        )}
      >
        {source.state === "syncing" ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : needsAttention ? (
          <AlertTriangle className="size-3.5" aria-hidden />
        ) : source.state === "paused" ? (
          <PauseCircle className="size-3.5" aria-hidden />
        ) : source.state === "on" ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <CalendarIcon className="size-3.5" aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{source.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {source.detail}
        </p>
      </div>

      {badge ? (
        <Badge variant="outline" className={cn("shrink-0", badge.tone)}>
          {badge.label}
        </Badge>
      ) : null}

      {source.fix ? (
        <Button
          type="button"
          variant={needsAttention ? "default" : "outline"}
          size="sm"
          disabled={busy || pending}
          className="shrink-0"
          onClick={() => {
            if (source.kind === "link" && source.state === "paused") {
              run(
                () => updateCalendarSubscription(source.id, { enabled: true }),
                TOAST_COPY.saveFailed,
              );
              return;
            }
            onFix();
          }}
        >
          {source.fix.label}
        </Button>
      ) : null}

      {source.kind === "link" ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            title="Check now"
            onClick={() =>
              run(
                () => syncCalendarSubscriptionNow(source.id),
                TOAST_COPY.saveFailed,
              )
            }
          >
            <RefreshCw className="size-3.5" />
            <span className="sr-only">Check {source.name} now</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(async () => {
                await removeCalendarSubscription(source.id);
                setGone(true);
              }, TOAST_COPY.deleteFailed)
            }
          >
            Remove
          </Button>
        </>
      ) : null}
    </li>
  );
}
