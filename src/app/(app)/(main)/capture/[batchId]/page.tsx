import { notFound } from "next/navigation";
import { getNoteBatch } from "@/actions/note-batches";
import { NoteBatchResultView } from "@/components/capture/note-batch-result";
import { isoDay } from "@/lib/suggested-reminder-utils";

export default async function NoteBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const batch = await getNoteBatch(batchId);
  if (!batch) notFound();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          What your notes produced
        </h1>
        <p className="mt-1 text-muted-foreground">
          Everything below was created from this paste. Dismiss anything that
          is wrong, or undo the whole batch.
        </p>
      </div>
      <NoteBatchResultView
        batchId={batch.id}
        status={batch.status}
        anchorIso={isoDay(new Date(batch.anchorDate))}
        anchorBasis={batch.anchorBasis}
        result={batch.result}
        reminderStatus={batch.reminderStatus}
        reminderDetails={batch.reminderDetails}
        contactNames={batch.contactNames}
      />
    </div>
  );
}
