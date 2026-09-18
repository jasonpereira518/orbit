import { Suspense } from "react";
import { loadReminderRail, loadRemindersPage } from "@/actions/reminders";
import { listSuggestedReminders } from "@/actions/suggested-reminders";
import { getCalendarFeedStatus } from "@/actions/calendar-feed";
import { RemindersStage } from "@/components/reminders/reminders-stage";
import type { RailTarget } from "@/components/reminders/reminder-rail";
import { RemindersStageSkeleton } from "@/components/loading/page-skeletons";
import { isReminderActionKind } from "@/lib/reminder-action-kind";
import { isReminderSource, isReminderView } from "@/lib/reminders-page";

type Params = {
  view?: string;
  list?: string;
  q?: string;
  kind?: string;
  source?: string;
  contact?: string;
  /** From the ⌘K palette's "New reminder": open the create form on arrival. */
  new?: string;
};

export default function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  return (
    <Suspense fallback={<RemindersStageSkeleton />}>
      <RemindersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function RemindersContent({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const target: RailTarget = params.list
    ? { kind: "list", id: params.list }
    : params.view === "suggested"
      ? { kind: "view", view: "suggested" }
      : { kind: "view", view: isReminderView(params.view) ? params.view : "today" };

  const kinds = (params.kind ?? "").split(",").filter(isReminderActionKind);
  const sources = (params.source ?? "").split(",").filter(isReminderSource);
  const q = (params.q ?? "").slice(0, 200);
  const contactId = params.contact || null;
  const suggestedView = target.kind === "view" && target.view === "suggested";

  const [rail, page, suggested, calendar] = await Promise.all([
    loadReminderRail(),
    loadRemindersPage({
      view: target.kind === "view" && target.view !== "suggested" ? target.view : null,
      listId: target.kind === "list" ? target.id : null,
      q,
      kinds,
      sources,
      contactId,
    }),
    suggestedView ? listSuggestedReminders() : Promise.resolve(null),
    // The rail's calendar-sync row. A failure here only costs that row its status.
    getCalendarFeedStatus().catch(() => null),
  ]);

  // A list id that isn't (or is no longer) yours: the query already fell back to Today, so
  // the rail should say so too.
  const resolvedTarget: RailTarget =
    target.kind === "list" && !rail.lists.some((l) => l.id === target.id)
      ? { kind: "view", view: "today" }
      : target;

  return (
    <RemindersStage
      target={resolvedTarget}
      counts={rail.counts}
      lists={rail.lists}
      inboxId={rail.inboxId}
      page={page}
      filters={{ q, kinds, sources, contact: page.contactFilter ?? null }}
      suggested={suggested}
      openCreate={params.new === "1"}
      calendar={
        calendar
          ? {
              enabled: calendar.enabled,
              lastFetchedAt: calendar.lastFetchedAt
                ? new Date(calendar.lastFetchedAt).toISOString()
                : null,
            }
          : undefined
      }
    />
  );
}
