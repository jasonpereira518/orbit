"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addCalendarSubscription,
  removeCalendarSubscription,
  syncCalendarSubscriptionNow,
  updateCalendarSubscription,
} from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Sub = {
  id: string;
  label: string | null;
  icsUrl: string;
  selfEmail: string | null;
  enabled: number;
  lastSyncedAt: Date | string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncStats: {
    scanned?: number;
    matched?: number;
    created?: number;
    updated?: number;
    contactsCreated?: number;
  } | null;
};

export function CalendarSubscribePanel({
  initialSubscriptions,
}: {
  initialSubscriptions: Sub[];
}) {
  const [subs, setSubs] = useState(initialSubscriptions);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [selfEmail, setSelfEmail] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <p className="text-sm font-medium">Subscribe to a calendar feed</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a private ICS URL (Google: Settings → Integrate calendar → Secret
          address in iCal format). Orbit polls it and keeps 1:1 / networking
          events in sync — team standups and focus blocks are ignored.
        </p>
      </div>

      <div className="space-y-2">
        <Input
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            placeholder="Your email on this calendar (optional)"
            type="email"
            value={selfEmail}
            onChange={(e) => setSelfEmail(e.target.value)}
          />
        </div>
        <Button
          disabled={!url.trim() || pending}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() =>
            start(async () => {
              try {
                const res = await addCalendarSubscription({
                  icsUrl: url.trim(),
                  label: label.trim() || undefined,
                  selfEmail: selfEmail.trim() || undefined,
                });
                setSubs((prev) => [res.subscription as Sub, ...prev]);
                setUrl("");
                if (res.syncError) {
                  toast.error(`Saved, but sync failed: ${res.syncError}`);
                } else if (res.stats) {
                  toast.success(
                    `Synced: ${res.stats.created} added, ${res.stats.updated} updated, ${res.stats.contactsCreated} contacts created`
                  );
                } else {
                  toast.success("Calendar subscribed");
                }
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Could not subscribe"
                );
              }
            })
          }
        >
          {pending ? "Subscribing…" : "Subscribe & sync"}
        </Button>
      </div>

      {subs.length > 0 && (
        <ul className="space-y-3 border-t border-border/50 pt-4">
          {subs.map((s) => (
            <li
              key={s.id}
              className="rounded-xl border border-border/60 px-4 py-3 text-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{s.label || "Calendar"}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {s.icsUrl}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge variant={s.enabled ? "secondary" : "outline"}>
                      {s.enabled ? "Enabled" : "Paused"}
                    </Badge>
                    {s.lastSyncStatus && (
                      <Badge
                        variant={
                          s.lastSyncStatus === "ok" ? "outline" : "destructive"
                        }
                      >
                        {s.lastSyncStatus}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {s.lastSyncedAt
                      ? `Last sync ${new Date(s.lastSyncedAt).toLocaleString()}`
                      : "Not synced yet"}
                    {s.lastSyncStats
                      ? ` · ${s.lastSyncStats.matched ?? 0} networking events · ${s.lastSyncStats.created ?? 0} new · ${s.lastSyncStats.updated ?? 0} updated`
                      : ""}
                  </p>
                  {s.lastSyncError && (
                    <p className="mt-1 text-xs text-destructive">
                      {s.lastSyncError}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !s.enabled}
                    onClick={() =>
                      start(async () => {
                        try {
                          const stats = await syncCalendarSubscriptionNow(s.id);
                          setSubs((prev) =>
                            prev.map((x) =>
                              x.id === s.id
                                ? {
                                    ...x,
                                    lastSyncedAt: new Date(),
                                    lastSyncStatus: "ok",
                                    lastSyncError: null,
                                    lastSyncStats: stats,
                                  }
                                : x
                            )
                          );
                          toast.success(
                            `Synced: ${stats.created} added, ${stats.updated} updated`
                          );
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Sync failed"
                          );
                        }
                      })
                    }
                  >
                    Sync now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const next = !s.enabled;
                        await updateCalendarSubscription(s.id, {
                          enabled: next,
                        });
                        setSubs((prev) =>
                          prev.map((x) =>
                            x.id === s.id ? { ...x, enabled: next ? 1 : 0 } : x
                          )
                        );
                        toast.success(next ? "Enabled" : "Paused");
                      })
                    }
                  >
                    {s.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        await removeCalendarSubscription(s.id);
                        setSubs((prev) => prev.filter((x) => x.id !== s.id));
                        toast.success("Removed subscription");
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
