import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getNoteBatch } from "@/actions/note-batches";
import { CaptureSourceCard } from "@/components/capture/capture-source-card";
import { NoteBatchResultView } from "@/components/capture/note-batch-result";
import { captureSourceKinds } from "@/lib/note-batches";
import { isoDay } from "@/lib/suggested-reminder-utils";

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
      <div>
        {/* This page is reachable from the capture history as well as straight after a
            save, so it needs a way back that is not the browser's. */}
        <Link
          href="/capture"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Capture
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          {fromMeeting ? "What your meeting produced" : "What your notes produced"}
        </h1>
        <p className="mt-1 text-muted-foreground">
          Everything below was created from this {fromMeeting ? "meeting" : "paste"}. Dismiss
          anything that is wrong, or undo the whole batch.
        </p>
      </div>
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
