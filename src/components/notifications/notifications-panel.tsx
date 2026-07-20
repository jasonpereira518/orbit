"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  Check,
  Clock,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  completeContactFollowUp,
  dismissSuggestion,
  listNotificationPanel,
  markReminderDone,
  snoozeReminderAction,
} from "@/actions/reminders";
import { Button, buttonVariants } from "@/components/ui/button";
import { ExpandableText } from "@/components/ui/expandable-text";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type PanelData = Awaited<ReturnType<typeof listNotificationPanel>>;
type PanelItem = PanelData["items"][number];

export function NotificationsPanelButton() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listNotificationPanel();
      setData(next);
    } catch {
      toast.error("Could not load notifications");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 120_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const dueCount = data?.dueCount ?? 0;
  const dueItems = data?.items.filter((i) => i.urgency === "due") ?? [];
  const upcomingItems =
    data?.items.filter((i) => i.urgency === "upcoming") ?? [];
  const suggestionItems =
    data?.items.filter((i) => i.urgency === "info") ?? [];

  function runAction(label: string, action: () => Promise<unknown>) {
    start(async () => {
      try {
        await action();
        toast.success(label);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="relative size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md hover:bg-background"
        aria-label={
          dueCount > 0
            ? `Open notifications, ${dueCount} due`
            : "Open notifications"
        }
        onClick={() => setOpen(true)}
      >
        <Bell className="h-4 w-4" />
        {dueCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {dueCount > 99 ? "99+" : dueCount}
          </span>
        )}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
          showCloseButton
        >
          <SheetHeader className="border-b border-border/60 pr-12">
            <SheetTitle className="font-[family-name:var(--font-display)] text-lg text-primary">
              Notifications
            </SheetTitle>
            <SheetDescription>
              Reminders, due follow-ups, and outreach suggestions.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {loading && !data ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !data || data.totalCount === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-4 py-10 text-center">
                <Bell className="mx-auto h-5 w-5 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium text-primary">
                  You&apos;re all caught up
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  New reminders and follow-ups will show up here.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <Section title="Due now" count={dueItems.length}>
                  {dueItems.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      pending={pending}
                      onDone={() => {
                        if (item.kind === "reminder" && item.reminderId) {
                          runAction("Marked done", () =>
                            markReminderDone(item.reminderId!)
                          );
                        } else if (
                          item.kind === "follow_up" &&
                          item.contactId
                        ) {
                          runAction("Follow-up cleared", () =>
                            completeContactFollowUp(item.contactId!)
                          );
                        }
                      }}
                      onSnooze={() => {
                        if (item.kind === "reminder" && item.reminderId) {
                          runAction("Snoozed 7 days", () =>
                            snoozeReminderAction(item.reminderId!, 7)
                          );
                        }
                      }}
                      onDismiss={() => {
                        if (item.kind === "suggestion" && item.suggestionId) {
                          runAction("Dismissed", () =>
                            dismissSuggestion(item.suggestionId!)
                          );
                        }
                      }}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </Section>

                <Section title="Upcoming" count={upcomingItems.length}>
                  {upcomingItems.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      pending={pending}
                      onDone={() => {
                        if (item.kind === "reminder" && item.reminderId) {
                          runAction("Marked done", () =>
                            markReminderDone(item.reminderId!)
                          );
                        } else if (
                          item.kind === "follow_up" &&
                          item.contactId
                        ) {
                          runAction("Follow-up cleared", () =>
                            completeContactFollowUp(item.contactId!)
                          );
                        }
                      }}
                      onSnooze={() => {
                        if (item.kind === "reminder" && item.reminderId) {
                          runAction("Snoozed 7 days", () =>
                            snoozeReminderAction(item.reminderId!, 7)
                          );
                        }
                      }}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </Section>

                <Section title="Suggestions" count={suggestionItems.length}>
                  {suggestionItems.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      pending={pending}
                      onDismiss={() => {
                        if (item.suggestionId) {
                          runAction("Dismissed", () =>
                            dismissSuggestion(item.suggestionId!)
                          );
                        }
                      }}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </Section>
              </div>
            )}
          </div>

          <div className="border-t border-border/60 p-4">
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Open dashboard
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function NotificationRow({
  item,
  pending,
  onDone,
  onSnooze,
  onDismiss,
  onNavigate,
}: {
  item: PanelItem;
  pending: boolean;
  onDone?: () => void;
  onSnooze?: () => void;
  onDismiss?: () => void;
  onNavigate: () => void;
}) {
  const Icon =
    item.kind === "reminder"
      ? Bell
      : item.kind === "follow_up"
        ? UserRound
        : Sparkles;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-card p-3",
        item.urgency === "due" && "border-primary/25 bg-primary/[0.03]"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <Link
            href={item.url}
            onClick={onNavigate}
            className="font-medium text-primary hover:underline"
          >
            {item.title}
          </Link>
          {item.body && (
            <ExpandableText text={item.body} lines={2} className="mt-0.5" />
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {item.dueAt
              ? formatDistanceToNow(new Date(item.dueAt), { addSuffix: true })
              : item.kind === "suggestion"
                ? "Outreach tip"
                : "No due date"}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {(item.kind === "reminder" || item.kind === "follow_up") && onDone && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onDone}
          >
            <Check className="h-3.5 w-3.5" />
            Done
          </Button>
        )}
        {item.kind === "reminder" && onSnooze && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onSnooze}
          >
            <Clock className="h-3.5 w-3.5" />
            Snooze
          </Button>
        )}
        {item.kind === "suggestion" && onDismiss && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
            Dismiss
          </Button>
        )}
        <Link
          href={item.url}
          onClick={onNavigate}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "ml-auto"
          )}
        >
          Open
        </Link>
      </div>
    </div>
  );
}
