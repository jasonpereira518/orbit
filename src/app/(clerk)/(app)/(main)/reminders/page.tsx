import { Suspense } from "react";
import { listRemindersPage } from "@/actions/reminders";
import { listSuggestedReminders } from "@/actions/suggested-reminders";
import { RemindersHeader } from "@/components/reminders/reminders-header";
import { RemindersView } from "@/components/reminders/reminders-view";
import { SuggestedRemindersPanel } from "@/components/reminders/suggested-reminders-panel";
import { RemindersViewSkeleton } from "@/components/loading/page-skeletons";

export default function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string; status?: string }>;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <RemindersHeader />
      {/* Its own boundary so an extra query never delays the reminders list. */}
      <Suspense fallback={null}>
        <SuggestedRemindersSection />
      </Suspense>
      <Suspense fallback={<RemindersViewSkeleton />}>
        <RemindersContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SuggestedRemindersSection() {
  const items = await listSuggestedReminders();
  if (!items.length) return null;
  return (
    <div className="reveal-mount">
      <SuggestedRemindersPanel items={items} />
    </div>
  );
}

async function RemindersContent({
  searchParams,
}: {
  searchParams: Promise<{ list?: string; status?: string }>;
}) {
  const params = await searchParams;
  const statusParam = params.status;
  const status =
    statusParam === "done" || statusParam === "all" ? statusParam : "pending";

  const data = await listRemindersPage({
    listId: params.list || null,
    status,
  });

  return (
    <div className="reveal-mount">
      <RemindersView
        lists={data.lists}
        selectedListId={data.selectedListId}
        status={data.status}
        reminders={data.reminders}
      />
    </div>
  );
}
