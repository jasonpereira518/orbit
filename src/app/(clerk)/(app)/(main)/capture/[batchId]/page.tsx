import { notFound } from "next/navigation";
import { getNoteBatch } from "@/actions/note-batches";
import { CaptureSourceCard } from "@/components/capture/capture-source-card";
import { NoteBatchResultView } from "@/components/capture/note-batch-result";
import { captureSourceKinds } from "@/lib/note-batches";
import { isoDay } from "@/lib/suggested-reminder-utils";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";

export default async function NoteBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const batch = await getNoteBatch(batchId);
  if (!batch) notFound();
  const fromMeeting = Boolean(batch.result.meeting);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      {/* Reachable from the capture history as well as straight after a save, so it needs a
          way back that is not the browser's. */}
      <PageHeader
        back={{ href: "/capture", label: "Capture" }}
        title={fromMeeting ? "What your meeting produced" : "What your notes produced"}
        subtitle={
          <>
            Here is everything Orbit made from this {fromMeeting ? "meeting" : "capture"}: the
            people, the things to do, and the reminders. Dismiss anything that looks wrong, or
            undo the whole batch.
          </>
        }
      />
      <CaptureSourceCard
        createdAt={new Date(batch.createdAt).toISOString()}
        kinds={captureSourceKinds(
          batch.photos.length && !batch.inputSources.includes("photo")
            ? [...batch.inputSources, "photo"]
            : batch.inputSources
        )}
        sourceText={batch.sourceText}
        photos={batch.photos.map((p) => ({
          id: p.id,
          fileName: p.fileName,
          width: p.width,
          height: p.height,
        }))}
      />
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
