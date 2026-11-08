import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BellRing, Users } from "lucide-react";
import { getNoteBatch } from "@/actions/note-batches";
import { CaptureSourceCard, CapturedAt } from "@/components/capture/capture-source-card";
import { CAPTURE_METHOD_META } from "@/components/capture/capture-source-meta";
import { NoteSourceMark } from "@/components/capture/note-source-mark";
import { NoteBatchResultView } from "@/components/capture/note-batch-result";
import { Badge } from "@/components/ui/badge";
import { requireUserId } from "@/lib/auth";
import { captureMethodFor } from "@/lib/capture-history";
import { captureAttendeeNames, captureHistoryTitle, captureSourceKinds } from "@/lib/note-batches";
import { isoDay } from "@/lib/suggested-reminder-utils";
import { RenderStamp } from "@/components/layout/render-stamp";

export const metadata = { title: "Capture results" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function NoteBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const gate = await pageVisibilityGate("page.capture");
  if (gate) return gate;

  const { batchId } = await params;
  const batch = await getNoteBatch(batchId);
  if (!batch) notFound();
  const kinds = captureSourceKinds(
    batch.photos.length && !batch.inputSources.includes("photo")
      ? [...batch.inputSources, "photo"]
      : batch.inputSources
  );
  const method = CAPTURE_METHOD_META[await captureMethodFor(await requireUserId(), { id: batch.id, result: batch.result, kinds })];
  const names = captureAttendeeNames(batch.result.participants);
  // The same line its Recent captures row is recognised by, else the method label, as there.
  const title =
    captureHistoryTitle({
      meetingTitle: batch.result.meeting?.title,
      head: batch.sourceText,
      names,
      reminders: batch.result.reminders,
    }) ?? method.label;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      {/* This page is reachable from the capture history as well as straight after a
          save, so it needs a way back that is not the browser's. */}
      <Link
        href="/capture"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Capture
      </Link>

      <NoteBatchResultView
        batchId={batch.id}
        status={batch.status}
        anchorIso={isoDay(new Date(batch.anchorDate))}
        anchorBasis={batch.anchorBasis}
        result={batch.result}
        reminderStatus={batch.reminderStatus}
        reminderDetails={batch.reminderDetails}
        contactNames={batch.contactNames}
        contactAvatars={batch.contactAvatars}
        heading={
          <div className="space-y-2">
            <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">{title}</h1>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <CapturedAt iso={new Date(batch.createdAt).toISOString()} />
              <span className="inline-flex items-center gap-1.5">
                <NoteSourceMark source={method.source} className="size-4" /> {method.label}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-4" aria-hidden /> {plural(names.length, "person", "people")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <BellRing className="size-4" aria-hidden /> {plural(batch.result.reminders.length, "reminder", "reminders")}
              </span>
              {batch.status === "undone" && <Badge variant="secondary">Undone</Badge>}
            </p>
          </div>
        }
      >
        <CaptureSourceCard
          kinds={kinds}
          sourceText={batch.sourceText}
          photos={batch.photos.map((p) => ({
            id: p.id,
            fileName: p.fileName,
            width: p.width,
            height: p.height,
          }))}
        />
      </NoteBatchResultView>
    </div>
  );
}
