"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { CalendarSync, Check, Copy, ExternalLink } from "lucide-react";
import {
  enableCalendarFeed,
  regenerateCalendarFeedToken,
  type CalendarFeedStatus,
} from "@/actions/calendar-feed";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { integrationHref } from "@/components/settings/sections";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type CalendarSyncSummary = { enabled: boolean; lastFetchedAt: string | null };

/**
 * Calendar sync, at the foot of the reminders rail — the page's own way to put dated
 * reminders into Google, Apple or Outlook calendar, where it used to be a text link off to
 * Settings.
 *
 * The feed's link is stored only as a hash, so an existing link can never be shown again.
 * That shapes this: off → one click makes the link and offers the ways to add it, right
 * here; on → the status, and "add to another calendar", which has to make a NEW link and
 * so stops old subscriptions updating (said before, not after). Turning it off and the
 * full detail stay in Settings.
 */
export function ReminderCalendarSync({ initial }: { initial: CalendarSyncSummary }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(initial);
  const [fresh, setFresh] = useState<CalendarFeedStatus | null>(null);
  const [confirmingNew, setConfirmingNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  // A refreshed page is newer than what this row last knew.
  const [syncedFrom, setSyncedFrom] = useState(initial);
  if (syncedFrom !== initial) {
    setSyncedFrom(initial);
    setSummary(initial);
  }

  const lastFetched = summary.lastFetchedAt ? new Date(summary.lastFetchedAt) : null;
  const statusText = !summary.enabled
    ? "Off"
    : lastFetched
      ? `Updated ${formatDistanceToNow(lastFetched, { addSuffix: true })}`
      : "Waiting for your calendar";

  function mint(fn: () => Promise<CalendarFeedStatus>, success: string) {
    start(async () => {
      try {
        const next = await fn();
        setFresh(next);
        setSummary({ enabled: next.enabled, lastFetchedAt: next.lastFetchedAt ? new Date(next.lastFetchedAt).toISOString() : null });
        setConfirmingNew(false);
        toast.success(success, { keep: false });
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t make a calendar link — try again?"));
      }
    });
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn’t copy — select the link and copy it instead");
    }
  }

  const linkAction = cn(
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border/70 px-2.5 text-xs font-medium transition-colors hover:bg-muted"
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // The link is shown once; closing the popover is the end of "once".
          setFresh(null);
          setConfirmingNew(false);
        }
      }}
    >
      <PopoverTrigger
        type="button"
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none transition-colors duration-fast hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <CalendarSync className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">Calendar sync</span>
          <span className="block truncate text-[11px] text-muted-foreground">{statusText}</span>
        </span>
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            !summary.enabled ? "bg-border" : lastFetched ? "bg-emerald-500" : "bg-amber-500"
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-80 space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-lg ring-0"
      >
        <div>
          <p className="text-sm font-medium">Reminders in your calendar</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Dated reminders appear in Google, Apple or Outlook calendar as all-day events.
            One-way: each calendar checks for changes on its own schedule — Google can take
            up to a day.
          </p>
        </div>

        {fresh?.url ? (
          <div className="space-y-2 rounded-xl bg-muted/50 p-3">
            <p className="text-xs font-medium">Add it now — Orbit won’t show this link again.</p>
            <div className="flex flex-wrap gap-1.5">
              {fresh.googleAddUrl && (
                <a href={fresh.googleAddUrl} target="_blank" rel="noreferrer" className={linkAction}>
                  <ExternalLink className="size-3.5" /> Google Calendar
                </a>
              )}
              {fresh.webcalUrl && (
                <a href={fresh.webcalUrl} className={linkAction}>
                  <CalendarSync className="size-3.5" /> Apple Calendar
                </a>
              )}
              <button type="button" onClick={() => copy(fresh.url!)} className={linkAction}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              For Outlook, choose “Subscribe from web” and paste the link.
            </p>
          </div>
        ) : !summary.enabled ? (
          <Button
            size="sm"
            className="w-full"
            disabled={pending}
            onClick={() => mint(enableCalendarFeed, "Calendar link created")}
          >
            {pending ? "Creating…" : "Create calendar link"}
          </Button>
        ) : confirmingNew ? (
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <p className="text-xs">
              This makes a new link. Calendars using the current one will stop updating until
              you add the new one to them.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" className="h-8" onClick={() => setConfirmingNew(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-8"
                disabled={pending}
                onClick={() => mint(regenerateCalendarFeedToken, "New calendar link created")}
              >
                {pending ? "Creating…" : "Make a new link"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {lastFetched
                ? `Your calendar last checked ${formatDistanceToNow(lastFetched, { addSuffix: true })}.`
                : "The link exists, but no calendar has checked it yet."}
            </p>
            <Button size="sm" variant="outline" className="w-full" onClick={() => setConfirmingNew(true)}>
              Add to another calendar
            </Button>
          </div>
        )}

        <Link
          href={integrationHref("reminders")}
          className="block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Manage or turn off in Settings →
        </Link>
      </PopoverContent>
    </Popover>
  );
}
