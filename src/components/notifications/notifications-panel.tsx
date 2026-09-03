"use client";

import Link from "next/link";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  Sparkles,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  clearContactFollowUp,
  dismissSuggestion,
  listNotificationPanel,
  markReminderDone,
  snoozeReminderAction,
} from "@/actions/reminders";
import {
  confirmSuggestedReminder,
  discardSuggestedReminder,
} from "@/actions/suggested-reminders";
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
import { ExtensionPromo } from "@/components/notifications/extension-promo";
import {
  dismissBackgroundJob,
  useActiveBackgroundJobCount,
  useBackgroundJobs,
  type BackgroundJob,
} from "@/lib/background-jobs";

type PanelData = Awaited<ReturnType<typeof listNotificationPanel>>;
type PanelItem = PanelData["items"][number];

/* -------------------------------------------------------------------------- */
/* Shared panel state                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One poll for the whole app, not one per mounted button.
 *
 * `AppShell` renders this button twice — once in the mobile header, once in the fixed
 * desktop slot — and CSS hides whichever breakpoint does not apply. CSS does not stop
 * React from mounting both, so a per-component effect meant two `listNotificationPanel()`
 * round trips on every page load and two more every two minutes, in every open tab,
 * forever. Hoisting the state above the component means both mounts read one cache, share
 * one timer, and collapse simultaneous refreshes into a single request.
 *
 * The same shape as `src/lib/background-jobs.ts`, which this component already consumes.
 */
const REFRESH_MS = 120_000;

type PanelSnapshot = { data: PanelData | null; loading: boolean };

const EMPTY_SNAPSHOT: PanelSnapshot = { data: null, loading: false };

let snapshot: PanelSnapshot = EMPTY_SNAPSHOT;
let inFlight: Promise<void> | null = null;
let latestRequest = 0;
let timerId: number | null = null;
const listeners = new Set<() => void>();

function setSnapshot(next: Partial<PanelSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

/**
 * Refreshes the panel.
 *
 * Ambient callers (mount, the interval, opening the sheet) share whatever request is
 * already running — that is what collapses the two mounts' first fetch into one.
 * `force` is for refreshing *after* a mutation, which must not be served by a request
 * that was issued before the mutation landed, or the panel silently reverts what the
 * user just did. `requestId` keeps the newest response the winner regardless of the
 * order the two come back in.
 */
function refreshPanel(force = false): Promise<void> {
  if (inFlight && !force) return inFlight;

  const requestId = ++latestRequest;
  setSnapshot({ loading: true });

  const run = listNotificationPanel()
    .then((next) => {
      if (requestId === latestRequest) setSnapshot({ data: next });
    })
    .catch(() => {
      if (requestId === latestRequest) toast.error("Could not load notifications");
    })
    .finally(() => {
      if (requestId !== latestRequest) return;
      inFlight = null;
      setSnapshot({ loading: false });
    });

  inFlight = run;
  return run;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // First mount starts the shared timer; the last unmount stops it.
  if (listeners.size === 1 && timerId === null) {
    timerId = window.setInterval(() => {
      // A hidden tab has no badge to update, and the old per-component interval kept
      // every backgrounded tab polling regardless.
      if (document.visibilityState === "visible") void refreshPanel();
    }, REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      // Dropped when the shell unmounts (signing out, or navigating to marketing) so a
      // subsequent session cannot paint the previous account's counts before its own
      // first fetch lands. Costs nothing: remounting refetches regardless.
      snapshot = EMPTY_SNAPSHOT;
    }
  };
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot(): PanelSnapshot {
  return EMPTY_SNAPSHOT;
}

export function NotificationsPanelButton() {
  const [open, setOpen] = useState(false);
  const { data, loading } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  const [pending, start] = useTransition();

  useEffect(() => {
    void refreshPanel();
  }, []);

  useEffect(() => {
    if (open) void refreshPanel();
  }, [open]);

  const jobs = useBackgroundJobs();
  const activeJobCount = useActiveBackgroundJobCount();
  const dueCount = data?.dueCount ?? 0;
  const badgeCount = dueCount + activeJobCount;
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
        await refreshPanel(true);
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
          badgeCount > 0
            ? `Open notifications, ${badgeCount} due or in progress`
            : "Open notifications"
        }
        onClick={() => setOpen(true)}
      >
        <Bell className="h-4 w-4" />
        {badgeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {badgeCount > 99 ? "99+" : badgeCount}
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
            <SheetTitle className="font-[family-name:var(--font-display)] text-lg text-ink">
              Notifications
            </SheetTitle>
            <SheetDescription>
              Reminders, due follow-ups, and outreach suggestions.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {data && <ExtensionPromo canUseExtension={data.canUseExtension} />}

            {loading && !data ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (!data || data.totalCount === 0) && jobs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-4 py-10 text-center">
                <Bell className="mx-auto h-5 w-5 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium text-ink">
                  You&apos;re all caught up
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  New reminders and follow-ups will show up here.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <Section title="Tasks" count={jobs.length}>
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </Section>

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
                            clearContactFollowUp(item.contactId!)
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
                            clearContactFollowUp(item.contactId!)
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
                      onDone={() => {
                        if (item.suggestedReminderId) {
                          runAction("Reminder added", () =>
                            confirmSuggestedReminder(item.suggestedReminderId!)
                          );
                        }
                      }}
                      onDismiss={() => {
                        if (item.suggestedReminderId) {
                          runAction("Dismissed", () =>
                            discardSuggestedReminder(item.suggestedReminderId!)
                          );
                          return;
                        }
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

function JobRow({ job }: { job: BackgroundJob }) {
  const determinate = job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {job.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : job.status === "completed" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
          ) : job.status === "failed" ? (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">
            {job.status === "running"
              ? job.cancelling
                ? "Stopping…"
                : job.label
              : job.status === "completed"
                ? job.resultMessage || `${job.label} — done`
                : job.status === "failed"
                  ? job.error || `${job.label} failed`
                  : job.resultMessage || `${job.label} stopped`}
          </p>
          {job.status === "running" && (
            <div className="mt-1.5 space-y-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-border/80">
                <div
                  className={cn(
                    "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
                    !determinate && "w-1/3 animate-pulse"
                  )}
                  style={determinate ? { width: `${pct}%` } : undefined}
                />
              </div>
              {determinate && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {job.done} of {job.total} · {pct}%
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {job.status === "running" && job.onCancel && (
          <Button
            size="sm"
            variant="ghost"
            disabled={job.cancelling}
            onClick={job.onCancel}
          >
            <X className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
        {job.status !== "running" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dismissBackgroundJob(job.id)}
          >
            <X className="h-3.5 w-3.5" />
            Dismiss
          </Button>
        )}
      </div>
    </div>
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
        : item.kind === "suggested_reminder"
          ? CalendarClock
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
                : item.kind === "suggested_reminder"
                  ? "Found in your notes"
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
        {item.kind === "suggested_reminder" && onDone && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
            <Check className="h-3.5 w-3.5" />
            Add reminder
          </Button>
        )}
        {(item.kind === "suggestion" || item.kind === "suggested_reminder") &&
          onDismiss && (
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
        {item.externalUrl && (
          // Deliberately a plain <a target="_blank">, not a Link with onNavigate: the
          // point of this one is that the next step is NOT in Orbit. Closing the panel
          // and navigating away would lose the reminder the user is still working on.
          <a
            href={item.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            <Mail className="h-3.5 w-3.5" />
            {item.externalLabel ?? "Open email"}
          </a>
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
