"use client";

import { refreshPulse, useAppPulse } from "@/lib/app-pulse-store";
import type { AppPulse } from "@/lib/app-pulse";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useState,
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
  Shield,
  Sparkles,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { runToastAction } from "@/lib/toast";
import {
  clearContactFollowUp,
  dismissSuggestion,
  markReminderDone,
  reopenReminderAction,
  restoreSuggestion,
  snoozeReminderAction,
  unsnoozeReminderAction,
} from "@/actions/reminders";
import {
  confirmSuggestedReminder,
  discardSuggestedReminder,
  restoreSuggestedReminder,
} from "@/actions/suggested-reminders";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { AccountAlerts } from "@/components/notifications/account-alerts";
import {
  dismissBackgroundJob,
  useActiveBackgroundJobCount,
  useBackgroundJobs,
  type BackgroundJob,
} from "@/lib/background-jobs";
import {
  clearKeptNotifications,
  dismissKeptNotification,
  hasLiveAction,
  markKeptNotificationsRead,
  runKeptAction,
  useKeptNotifications,
  type KeptNotification,
} from "@/lib/kept-notifications";
import { PANEL_ORIGIN_FALLBACK, originFromTrigger } from "@/lib/floating-panel";

type PanelData = AppPulse["panel"];
type PanelItem = PanelData["items"][number];

/* -------------------------------------------------------------------------- */
/* Shared panel state                                                         */
/* -------------------------------------------------------------------------- */

// The panel is one slice of the app pulse (`src/lib/app-pulse-store.ts`): one poll per
// tab shared with the desktop-notification and plan-celebration watchers, rather than the
// three separate timers that used to run. `refreshPanel` keeps its old name and contract
// (`force` after a mutation) so the action handlers below read the same.
const refreshPanel = (force = false) => refreshPulse(force);

export function NotificationsPanelButton({
  tooltip = false,
}: {
  /**
   * Desktop rail only, mirroring `FeedbackTrigger`. Touch has no hover, so a tooltip on
   * the mobile header copy would be dead weight — the `aria-label` is the accessible name
   * either way.
   */
  tooltip?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  // Captured on click rather than read during render: there are two bells mounted (mobile
  // header and desktop fixed, hidden from each other by CSS), and this resolves to
  // whichever one the user actually pressed.
  const [origin, setOrigin] = useState(PANEL_ORIGIN_FALLBACK);
  const { pulse, loading } = useAppPulse();
  const data = pulse?.panel ?? null;
  const [pending, start] = useTransition();

  useEffect(() => {
    void refreshPanel();
  }, []);

  useEffect(() => {
    if (open) void refreshPanel();
  }, [open]);

  // Opening the panel is what "seen" means here. The entries stay in the list —
  // only the badge stops counting them.
  useEffect(() => {
    if (open) markKeptNotificationsRead();
  }, [open]);

  const jobs = useBackgroundJobs();
  const activeJobCount = useActiveBackgroundJobCount();
  const kept = useKeptNotifications();
  const unreadKeptCount = useMemo(
    () => kept.filter((entry) => !entry.read).length,
    [kept]
  );
  const dueCount = data?.dueCount ?? 0;
  // Unread missed notifications count toward the badge — that is the whole
  // point of keeping them; a failure nobody saw should say so on the bell.
  // They stop counting once the panel has been opened, but stay in the list.
  const badgeCount = dueCount + activeJobCount + unreadKeptCount;
  const dueItems = useMemo(
    () => data?.items.filter((i) => i.urgency === "due") ?? [],
    [data]
  );
  const upcomingItems = useMemo(
    () => data?.items.filter((i) => i.urgency === "upcoming") ?? [],
    [data]
  );
  const suggestionItems = useMemo(
    () => data?.items.filter((i) => i.urgency === "info") ?? [],
    [data]
  );
  const alerts = data?.alerts ?? [];
  // Account alerts deliberately do NOT count here. They live in the pinned footer, so an
  // alert-only account should still see the scroll area say there is nothing due rather
  // than render an empty region with no explanation.
  const hasAnything =
    (data?.totalCount ?? 0) > 0 || jobs.length > 0 || kept.length > 0;

  const refresh = () => refreshPanel(true);

  function markDone(reminderId: string) {
    start(() =>
      runToastAction({
        run: () => markReminderDone(reminderId),
        success: "Marked done",
        failure: "Couldn’t mark that done — try again?",
        refresh,
        undo: (snap) => (snap ? () => reopenReminderAction(snap) : null),
      }).then(() => undefined)
    );
  }

  function snooze(reminderId: string) {
    start(() =>
      runToastAction({
        run: () => snoozeReminderAction(reminderId, 7),
        success: "Snoozed for a week",
        failure: "Couldn’t snooze that — try again?",
        refresh,
        undo: (snap) => (snap ? () => unsnoozeReminderAction(snap) : null),
      }).then(() => undefined)
    );
  }

  // No Undo: this closes an unbounded set of the contact's reminders and returns only
  // how many, not which. It can say the count honestly, which it could not before.
  function clearFollowUp(contactId: string) {
    start(() =>
      runToastAction({
        run: () => clearContactFollowUp(contactId),
        success: (res) =>
          res.remindersClosed > 0
            ? `Follow-up cleared — ${res.remindersClosed} ${res.remindersClosed === 1 ? "reminder" : "reminders"} closed too`
            : "Follow-up cleared",
        failure: "Couldn’t clear that follow-up — try again?",
        refresh,
      }).then(() => undefined)
    );
  }

  function dismiss(suggestionId: string) {
    start(() =>
      runToastAction({
        run: () => dismissSuggestion(suggestionId),
        success: "Dismissed",
        failure: "Couldn’t dismiss that — try again?",
        refresh,
        undo: () => () => restoreSuggestion(suggestionId),
      }).then(() => undefined)
    );
  }

  function discardSuggested(suggestedReminderId: string) {
    start(() =>
      runToastAction({
        run: () => discardSuggestedReminder(suggestedReminderId),
        success: "Dismissed",
        failure: "Couldn’t dismiss that — try again?",
        refresh,
        undo: () => () => restoreSuggestedReminder(suggestedReminderId),
      }).then(() => undefined)
    );
  }

  function confirmSuggested(suggestedReminderId: string) {
    start(() =>
      runToastAction({
        run: () => confirmSuggestedReminder(suggestedReminderId),
        success: "Reminder added",
        failure: "Couldn’t add that reminder — try again?",
        refresh,
      }).then(() => undefined)
    );
  }

  const button = (
    <Button
      type="button"
        variant="outline"
        size="icon"
        className={cn(
          "relative size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md transition-opacity hover:bg-background",
          // The open window covers this exact spot, and the glass is see-through enough
          // that the bell would read as a smudge underneath it. Hiding it also sells the
          // illusion that the button became the panel. Opacity rather than `hidden` so it
          // stays focusable for the focus base-ui returns here on close.
          open
            ? "pointer-events-none opacity-0 duration-fast"
            : // Held back until the closing window has almost finished collapsing onto
              // this spot, so the two are never on screen together — the button appears to
              // be what the panel turned back into, rather than something waiting behind it.
              "opacity-100 delay-100 duration-base"
        )}
        aria-label={[
          "Open notifications",
          dueCount + activeJobCount > 0
            ? `${dueCount + activeJobCount} due or in progress`
            : null,
          // Counted separately from the phrase above: a missed failure is not
          // "due", and rolling it into that number would misdescribe it to a
          // screen reader even though the badge shows the two added together.
          unreadKeptCount > 0 ? `${unreadKeptCount} missed` : null,
          data?.alertDot ? "account needs attention" : null,
        ]
          .filter(Boolean)
          .join(", ")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          setOrigin(originFromTrigger(e.currentTarget));
          setOpen(true);
        }}
      >
        <Bell className="h-4 w-4" />
        {badgeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {badgeCount > 99 ? "99+" : badgeCount}
          </span>
        )}
        {/* Opposite corner from the count on purpose: alerts never add to the badge, and a
            dot sharing a corner with a two-digit number would collide with it. */}
        {data?.alertDot && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-destructive ring-2 ring-background"
          />
        )}
    </Button>
  );

  return (
    <>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent side="left">Notifications</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="floating"
          className="liquid-glass liquid-glass-panel gap-0 p-0"
          style={{ transformOrigin: origin }}
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

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {data && <ExtensionPromo canUseExtension={data.canUseExtension} />}

            {loading && !data ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !hasAnything ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-4 py-10 text-center">
                <Bell className="mx-auto h-5 w-5 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium text-ink">
                  {alerts.length > 0 ? "Nothing due" : "You're all caught up"}
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
                          markDone(item.reminderId);
                        } else if (
                          item.kind === "follow_up" &&
                          item.contactId
                        ) {
                          clearFollowUp(item.contactId);
                        }
                      }}
                      onSnooze={() => {
                        if (item.kind === "reminder" && item.reminderId) {
                          snooze(item.reminderId);
                        }
                      }}
                      onDismiss={() => {
                        if (item.kind === "suggestion" && item.suggestionId) {
                          dismiss(item.suggestionId);
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
                          markDone(item.reminderId);
                        } else if (
                          item.kind === "follow_up" &&
                          item.contactId
                        ) {
                          clearFollowUp(item.contactId);
                        }
                      }}
                      onSnooze={() => {
                        if (item.kind === "reminder" && item.reminderId) {
                          snooze(item.reminderId);
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
                          confirmSuggested(item.suggestedReminderId);
                        }
                      }}
                      onDismiss={() => {
                        if (item.suggestedReminderId) {
                          discardSuggested(item.suggestedReminderId);
                          return;
                        }
                        if (item.suggestionId) {
                          dismiss(item.suggestionId);
                        }
                      }}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </Section>

                {/* Background work, below the things the user is actually being asked to
                    do. Named for what it is — these are imports and backfills, not tasks. */}
                <Section title="In progress" count={jobs.length}>
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </Section>

                {/* Last, under everything the user is being asked to do: these are
                    things that already happened and were missed, not work outstanding. */}
                <Section title="Missed" count={kept.length}>
                  {kept.map((entry) => (
                    <KeptRow
                      key={entry.id}
                      entry={entry}
                      onAct={() => {
                        runKeptAction(entry.id);
                        dismissKeptNotification(entry.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                  {kept.length > 1 && (
                    <button
                      type="button"
                      className="px-0.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => clearKeptNotifications()}
                    >
                      Clear all
                    </button>
                  )}
                </Section>
              </div>
            )}

          </div>

          {/* Pinned to the foot of the window rather than sitting in the list above it.
              An alert is a standing statement about the account — an expired card, a failed
              import — and scrolling one out of sight is exactly how you stop acting on it.
              The list keeps its own scrollbar; `min-h-0` on it is what lets it give up the
              room this needs instead of overflowing the window.

              The cap is a backstop for the expanded state only: collapsed, this is at most
              `ALERTS_COLLAPSED_VISIBLE` rows and nowhere near 45% of the window, so the
              nested scroller the alerts docblock warns about never actually appears.

              It renders nothing when there are no live alerts, so the border comes from the
              component rather than from a wrapper that would otherwise draw a stray line. */}
          <AccountAlerts
            alerts={alerts}
            onNavigate={() => setOpen(false)}
            className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border/60 px-4 py-3"
          />

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 p-4">
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Open dashboard
            </Link>

            {/* Operators only, and the only way into the console from inside the product —
                there is no nav entry for it anywhere else. `canOpenAdmin` is resolved on
                the server; see the note on it in `listNotificationPanel`. */}
            {data?.canOpenAdmin && (
              <Link
                href="/admin"
                onClick={() => setOpen(false)}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "h-7 gap-1.5 px-2.5 text-xs"
                )}
              >
                <Shield className="h-3.5 w-3.5" />
                Admin console
              </Link>
            )}
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

/**
 * A toast that timed out before it was dealt with. Same row shape as `JobRow`,
 * but the icon carries the tone: a failure looks like a failure here too.
 *
 * The action button appears only while its callback is still in memory. After a
 * reload the entry survives (it is mirrored to localStorage) but the closure
 * does not, so the row states what happened without offering a button that
 * could not do anything. See `lib/kept-notifications.ts`.
 */
function KeptRow({
  entry,
  onAct,
}: {
  entry: KeptNotification;
  onAct: () => void;
}) {
  const actionable = !!entry.actionLabel && hasLiveAction(entry.id);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            entry.tone === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground"
          )}
        >
          {entry.tone === "error" ? (
            <XCircle className="h-3.5 w-3.5" />
          ) : (
            <Clock className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <ExpandableText text={entry.title} className="font-medium text-ink" />
          {entry.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {entry.description}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {formatDistanceToNow(entry.at, { addSuffix: true })}
            </p>
            {actionable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={onAct}
              >
                {entry.actionLabel}
              </Button>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label="Dismiss notification"
          onClick={() => dismissKeptNotification(entry.id)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
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
