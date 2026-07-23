import { Suspense } from "react";
import { listRemindersPage } from "@/actions/reminders";
import { RemindersView } from "@/components/reminders/reminders-view";

export default async function RemindersPage({
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
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Reminders
        </h1>
        <p className="mt-1 text-muted-foreground">
          Create, organize into lists, and take quick actions based on what each
          reminder means.
        </p>
      </div>

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <RemindersView
          lists={data.lists}
          selectedListId={data.selectedListId}
          status={data.status}
          reminders={data.reminders}
        />
      </Suspense>
    </div>
  );
}
