"use client";

import { refreshPulse, useAppPulse } from "@/lib/app-pulse-store";
import type { AppPulse } from "@/lib/app-pulse";
import Link from "next/link";
import {
  useEffect,
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
import { toast } from "@/lib/toast";
import {
  clearContactFollowUp,
  dismissSuggestion,
  markReminderDone,
  snoozeReminderAction,
} from "@/actions/reminders";
import {
  confirmSuggestedReminder,
  discardSuggestedReminder,
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

  const jobs = useBackgroundJobs();
  const activeJobCount = useActiveBackgroundJobCount();
  const dueCount = data?.dueCount ?? 0;
  const badgeCount = dueCount + activeJobCount;
  const dueItems = data?.items.filter((i) => i.urgency === "due") ?? [];
  const upcomingItems =
    data?.items.filter((i) => i.urgency === "upcoming") ?? [];
  const suggestionItems =
    data?.items.filter((i) => i.urgency === "info") ?? [];
  const alerts = data?.alerts ?? [];
  // Account alerts deliberately do NOT count here. They live in the pinned footer, so an
  // alert-only account should still see the scroll area say there is nothing due rather
  // than render an empty region with no explanation.
  const hasAnything = (data?.totalCount ?? 0) > 0 || jobs.length > 0;

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
          badgeCount > 0 ? `${badgeCount} due or in progress` : null,
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
          // Lighter than the shared default (`bg-black/10` + `backdrop-blur-xs`): the page
          // behind stays legible, and the window's own backdrop-filter does the blurring.
          // That is what makes this read as a pane of glass rather than as a modal.
          overlayClassName="bg-black/5 supports-backdrop-filter:backdrop-blur-[1.5px]"
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

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
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

                {/* Background work, below the things the user is actually being asked to
                    do. Named for what it is — these are imports and backfills, not tasks. */}
                <Section title="In progress" count={jobs.length}>
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </Section>
              </div>
            )}

            {/* Outside the ternary above, so an account whose only news is an alert still
                sees it — that branch renders the "nothing due" empty state instead of the
                section list. */}
            <AccountAlerts alerts={alerts} onNavigate={() => setOpen(false)} />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/60 p-4">
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
