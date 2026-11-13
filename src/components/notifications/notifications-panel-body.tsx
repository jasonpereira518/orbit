"use client";

/**
 * The notifications panel's contents: what is due, waiting, running and missed, with their
 * actions. Its own module so the bell in the app shell (`notifications-panel.tsx`) can load
 * it when the panel first opens rather than in every signed-in page's first load.
 */
import { refreshPulse, useAppPulse } from "@/lib/app-pulse-store";
import type { AppPulse } from "@/lib/app-pulse";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Gift,
  MessageSquareText,
  NotebookPen,
  Radar,
  Shield,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { runToastAction } from "@/lib/toast";
import {
  clearContactFollowUp,
  markReminderDone,
  reopenReminderAction,
  snoozeReminderAction,
  undoClearContactFollowUpAction,
  unsnoozeReminderAction,
} from "@/actions/reminders";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { companyBrandText } from "@/lib/company-brand";
import { playDing } from "@/lib/ding";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen } from "@/lib/feedback-events";
import { ExtensionPromo } from "@/components/notifications/extension-promo";
import { AccountAlerts } from "@/components/notifications/account-alerts";
import { RowBubble } from "@/components/notifications/row-bubble";
import { panelDismissals, panelItemKey, radarKey } from "@/lib/panel-dismissals";
import {
  dismissBackgroundJob,
  useBackgroundJobs,
  type BackgroundJob,
} from "@/lib/background-jobs";
import {
  clearKeptNotifications,
  dismissKeptNotification,
  hasLiveAction,
  runKeptAction,
  useKeptNotifications,
  type KeptNotification,
} from "@/lib/kept-notifications";

type PanelData = AppPulse["panel"];
type PanelItem = PanelData["items"][number];

const refreshPanel = (force = false) => refreshPulse(force);

/**
 * The panel is for what needs you now, not a full inbox: due reminders and follow-ups,
 * running work, and failures you missed. Upcoming items and outreach suggestions live on
 * /reminders and the dashboard. Past this many due rows the rest sit behind "See more".
 */
const DUE_VISIBLE = 5;

export function NotificationsPanelBody({ onClose }: { onClose: () => void }) {
  const { pulse, loading } = useAppPulse();
  const data = pulse?.panel ?? null;
  const [pending, start] = useTransition();
  const [showAllDue, setShowAllDue] = useState(false);
  const jobs = useBackgroundJobs();
  const kept = useKeptNotifications();
  // Re-renders when a row is cleared; `isDismissed` itself reads the device's list.
  const dismissedVersion = panelDismissals.useVersion();
  const dueItems = useMemo(
    // A feedback reply is "due" for the badge but lives under "Waiting on you": there is
    // nothing to mark done or snooze, only a conversation to open.
    () => data?.items.filter((i) => i.urgency === "due" && i.kind !== "feedback_reply") ?? [],
    [data]
  );
  // Captured notes waiting for review (or that failed) are the one "info" item worth a
  // slot here: the user has to act on them, and nothing else will surface them. Until they
  // clear it, which hides that row (`panel-dismissals.ts`) and nothing else.
  const captureItems = useMemo(
    () =>
      data?.items.filter(
        (i) =>
          (i.kind === "feedback_reply" || i.kind === "capture_review" || i.kind === "cloud_notes") &&
          !panelDismissals.isDismissed(panelItemKey(i))
      ) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `dismissedVersion` is the signal that the device's list changed
    [data, dismissedVersion]
  );
  const alerts = data?.alerts ?? [];
  // Radar's list as one line, never an item: a suggestion is not something due, so it
  // neither counts toward the badge nor lives under "Due now".
  const radar =
    data?.radar && !panelDismissals.isDismissed(radarKey(data.radar)) ? data.radar : null;
  // Account alerts deliberately do NOT count here. They live in the pinned footer, so an
  // alert-only account should still see the scroll area say there is nothing due rather
  // than render an empty region with no explanation.
  const hasAnything =
    dueItems.length > 0 ||
    captureItems.length > 0 ||
    radar !== null ||
    jobs.length > 0 ||
    kept.length > 0;

  const refresh = () => refreshPanel(true);

  // Everything that is not pressing clears: missed toasts, finished jobs, and the rows that
  // are only waiting to be looked at (captures, found notes, replies, Radar's line). What
  // stays is what is being asked of you now: due reminders and follow-ups (clearing one would
  // mean marking it done), running jobs, and account alerts.
  const finishedJobs = jobs.filter((j) => j.status !== "running");
  const clearable = kept.length + finishedJobs.length + captureItems.length + (radar ? 1 : 0) > 0;
  function clearAll() {
    clearKeptNotifications();
    for (const j of finishedJobs) dismissBackgroundJob(j.id);
    for (const i of captureItems) panelDismissals.dismiss(panelItemKey(i));
    if (radar) panelDismissals.dismiss(radarKey(radar));
  }

  function markDone(reminderId: string) {
    start(() =>
      runToastAction({
        run: () => markReminderDone(reminderId),
        success: "Marked done",
        failure: "Couldn’t mark that done — try again?",
        refresh,
        undo: (snap) => (snap ? () => reopenReminderAction(snap) : null),
        offline: { kind: "reminder.done", args: [reminderId], subject: reminderId },
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
        offline: { kind: "reminder.snooze", args: [reminderId, 7], subject: reminderId },
      }).then(() => undefined)
    );
  }

  // Undo puts back the contact's clock and every reminder this closed, each behind its own
  // staleness guard — the snapshot names them, where the bare count could not.
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
        undo: (res) => () => undoClearContactFollowUpAction(res.snapshot),
      }).then(() => undefined)
    );
  }

  return (
    <>
    <div className="min-h-[7rem] flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 [scrollbar-width:thin]">
      {data && <ExtensionPromo />}

      {clearable && (
        <div className="flex justify-end">
          <button
            type="button"
            className="px-0.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={clearAll}
          >
            Clear notifications
          </button>
        </div>
      )}

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
        <div className="space-y-4">
          <Section title="Due now" count={dueItems.length}>
            {(showAllDue ? dueItems : dueItems.slice(0, DUE_VISIBLE)).map((item) => (
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
                onNavigate={onClose}
              />
            ))}
            {dueItems.length > DUE_VISIBLE && (
              <button
                type="button"
                className="px-0.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                aria-expanded={showAllDue}
                onClick={() => setShowAllDue((v) => !v)}
              >
                {showAllDue
                  ? "See less"
                  : `See ${dueItems.length - DUE_VISIBLE} more`}
              </button>
            )}
          </Section>

          <Section title="Waiting on you" count={captureItems.length}>
            {captureItems.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                pending={pending}
                onNavigate={onClose}
              />
            ))}
          </Section>

          <Section title="Radar" count={radar ? 1 : 0}>
            {radar && (
              <RadarRow
                count={radar.count}
                drafts={radar.drafts}
                names={radar.names}
                today={radar.today ?? 0}
                todayNames={radar.todayNames ?? []}
                onNavigate={onClose}
              />
            )}
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
                  onClose();
                }}
              />
            ))}
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
        `ALERTS_COLLAPSED_VISIBLE` rows and nowhere near 30% of the window, so the
        nested scroller the alerts docblock warns about never actually appears.

        It renders nothing when there are no live alerts, so the border comes from the
        component rather than from a wrapper that would otherwise draw a stray line. */}
    <AccountAlerts
      alerts={alerts}
      onNavigate={onClose}
      className="max-h-[30%] shrink-0 overflow-y-auto border-t border-border/60 px-4 py-3"
    />

    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 p-4">
      <Link
        href="/dashboard"
        onClick={onClose}
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
          onClick={onClose}
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
 * Rows are one or two lines: a title, a single muted meta line, and icon-only actions on
 * the right. The old cards stacked an icon disc, a body paragraph and a button row.
 */
const ROW = "flex items-center gap-3 rounded-lg border border-border/30 bg-popover px-3.5 py-3";
/** Soft disc behind each row's leading icon. */
function IconDisc({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06]">
      {children}
    </span>
  );
}
const ICON_BTN = "size-7 shrink-0 text-muted-foreground";

/**
 * A toast that timed out before it was dealt with. The icon carries the tone: a failure
 * looks like a failure here too.
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
  const detail = `${formatDistanceToNow(entry.at, { addSuffix: true })}${entry.description ? ` · ${entry.description}` : ""}`;

  return (
    <div className={ROW}>
      <IconDisc>
        {entry.tone === "error" ? (
          <XCircle className="h-4 w-4 text-destructive" />
        ) : (
          <Clock className="h-4 w-4 text-muted-foreground" />
        )}
      </IconDisc>
      <RowBubble lines={[entry.title, detail]} render={<div className="min-w-0 flex-1" />}>
        <p className="truncate text-sm font-medium text-ink">{entry.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
      </RowBubble>
      {actionable && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={onAct}
        >
          {entry.actionLabel}
        </Button>
      )}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={ICON_BTN}
        aria-label={`Dismiss notification: ${entry.title}`}
        onClick={() => dismissKeptNotification(entry.id)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function JobRow({ job }: { job: BackgroundJob }) {
  const determinate = job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
  const running = job.status === "running";
  const headline = running
    ? job.cancelling
      ? "Stopping…"
      : job.label
    : job.status === "completed"
      ? job.resultMessage || `${job.label} — done`
      : job.status === "failed"
        ? job.error || `${job.label} failed`
        : job.resultMessage || `${job.label} stopped`;

  return (
    <div className={ROW}>
      <IconDisc>
      {running ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      ) : job.status === "completed" ? (
        <CheckCircle2 className="h-4 w-4 text-primary" />
      ) : job.status === "failed" ? (
        <XCircle className="h-4 w-4 text-destructive" />
      ) : (
        <XCircle className="h-4 w-4 text-muted-foreground" />
      )}
      </IconDisc>
      <RowBubble lines={[headline]} render={<div className="min-w-0 flex-1" />}>
        <p className="truncate text-sm font-medium text-ink">{headline}</p>
        {running && (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/80">
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
                  !determinate && "w-1/3 animate-pulse"
                )}
                style={determinate ? { width: `${pct}%` } : undefined}
              />
            </div>
            {determinate && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {pct}%
              </span>
            )}
          </div>
        )}
      </RowBubble>
      {running && job.onCancel && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          disabled={job.cancelling}
          onClick={job.onCancel}
        >
          Stop
        </Button>
      )}
      {!running && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={ICON_BTN}
          aria-label={`Dismiss: ${job.label}`}
          onClick={() => dismissBackgroundJob(job.id)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/** One line for Radar's whole list: how many people, and who is first. */
function RadarRow({
  count,
  drafts,
  names,
  today,
  todayNames,
  onNavigate,
}: {
  count: number;
  /** Today's cards with a message already written. Leads the line when there are any. */
  drafts: number;
  names: string[];
  /** Today's moments, the ones that won't keep: they lead the row and count on the badge. */
  today: number;
  todayNames: string[];
  onNavigate: () => void;
}) {
  const shown = names.slice(0, 3);
  const rest = count - shown.length;
  const headline =
    today > 0
      ? `Won’t keep: ${todayNames.join(", ")}${today > todayNames.length ? ` and ${today - todayNames.length} more` : ""}`
      : `${drafts > 0 ? `${drafts} ${drafts === 1 ? "draft" : "drafts"} ready · ` : ""}${count} ${count === 1 ? "person" : "people"} worth a message`;
  const detail =
    today > 0
      ? `${count > today ? `Plus ${count - today} more on this week’s plan` : "On Radar today"}${drafts > 0 ? ` · ${drafts} ${drafts === 1 ? "draft" : "drafts"} ready` : ""}`
      : `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
  return (
    <div className={cn(ROW, "bg-popover")}>
      <IconDisc>
        <Radar className="h-4 w-4 text-muted-foreground" />
      </IconDisc>
      <RowBubble
        lines={[headline, detail]}
        render={<Link href="/radar" onClick={onNavigate} className="min-w-0 flex-1 hover:underline" />}
      >
        <span className="block truncate text-sm font-medium text-ink">{headline}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
      </RowBubble>
    </div>
  );
}

function NotificationRow({
  item,
  pending,
  onDone,
  onSnooze,
  onNavigate,
}: {
  item: PanelItem;
  pending: boolean;
  onDone?: () => void;
  onSnooze?: () => void;
  onNavigate: () => void;
}) {
  // A feedback reply opens in the feedback side panel, over the page you're on, rather than
  // taking you away from it. The href stays for a new tab or a modifier-click.
  const openItem = (e: React.MouseEvent) => {
    if (item.kind === "feedback_reply" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const id = item.url.split("/").pop();
      if (id) requestFeedbackOpen(FEEDBACK_ANCHOR_FALLBACK, { view: "thread", id });
    }
    onNavigate();
  };
  const Icon =
    item.kind === "follow_up"
      ? UserRound
      : item.kind === "capture_review"
        ? NotebookPen
        : item.kind === "cloud_notes"
          ? FileText
          : item.kind === "feedback_reply"
            ? item.gift
              ? Gift
              : MessageSquareText
            : Bell;
  const when = item.dueAt
    ? formatDistanceToNow(new Date(item.dueAt), { addSuffix: true })
    : item.kind === "capture_review" || item.kind === "cloud_notes"
      ? "Waiting on you"
      : "No due date";
  // The subtitle as plain text, for the hover bubble (the on-screen one tints the company).
  const detail = [
    when,
    item.company ? [item.contactTitle, item.company].filter(Boolean).join(" · ") : item.body,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cn(ROW, "border-primary/15 bg-popover")}>
      <IconDisc>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </IconDisc>
      <RowBubble
        lines={[item.title, detail]}
        render={<Link href={item.url} onClick={(e) => openItem(e)} className="min-w-0 flex-1 hover:underline" />}
      >
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
          {item.priority === "critical" && (
            <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.2 text-2xs font-semibold text-rose-700 dark:text-rose-300">
              Critical
            </span>
          )}
          {item.priority === "high" && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.2 text-2xs font-semibold text-amber-700 dark:text-amber-300">
              High
            </span>
          )}
          <span className="truncate">{item.title}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {when}
          {item.company ? (
            <>
              {item.contactTitle ? ` · ${item.contactTitle}` : ""} ·{" "}
              <bdi
                className={cn("font-medium", companyBrandText(item.company)?.className)}
                style={companyBrandText(item.company)?.style}
              >
                {item.company}
              </bdi>
            </>
          ) : item.body ? (
            ` · ${item.body}`
          ) : (
            ""
          )}
        </span>
      </RowBubble>
      {item.kind === "reminder" && onSnooze && (
        <Button
          size="icon"
          variant="ghost"
          className={ICON_BTN}
          disabled={pending}
          aria-label={`Snooze 7 days: ${item.title}`}
          title="Snooze 7 days"
          onClick={onSnooze}
        >
          <Clock className="h-3.5 w-3.5" />
        </Button>
      )}
      {onDone && (
        <Button
          size="icon"
          variant="ghost"
          className={ICON_BTN}
          disabled={pending}
          aria-label={`Mark done: ${item.title}`}
          title="Mark done"
          onClick={() => {
            playDing();
            onDone();
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
