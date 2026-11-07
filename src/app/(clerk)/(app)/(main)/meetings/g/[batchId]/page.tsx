import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Link from "next/link";
import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Users } from "lucide-react";
import { getNoteBatch } from "@/actions/note-batches";
import { NoteBatchResultView } from "@/components/capture/note-batch-result";
import { RenderStamp } from "@/components/layout/render-stamp";
import { requireUserId } from "@/lib/auth";
import { getGranolaMeeting } from "@/lib/meetings-list";
import { isoDay } from "@/lib/suggested-reminder-utils";

/** Request-memoized so `generateMetadata` and the page share one read. */
const loadGranolaMeeting = cache((userId: string, id: string) => getGranolaMeeting(userId, id));

export async function generateMetadata({ params }: { params: Promise<{ batchId: string }> }): Promise<Metadata> {
  try {
    const meeting = await loadGranolaMeeting(await requireUserId(), (await params).batchId);
    return { title: meeting?.note.title || "Granola meeting" };
  } catch {
    return { title: "Granola meeting" };
  }
}

/** A meeting synced from Granola: Granola's own notes as written, then what Orbit saved from them. */
export default async function GranolaMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const gate = await pageVisibilityGate("page.meetings");
  if (gate) return gate;

  const { batchId } = await params;
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const userId = await requireUserId();
  const meeting = await loadGranolaMeeting(userId, batchId);
  if (!meeting) notFound();
  const batch = await getNoteBatch(meeting.id).catch(() => null);
  const people = meeting.result.participants.map((p) => p.name).filter(Boolean);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <Link
        href={q ? `/meetings?q=${encodeURIComponent(q)}` : "/meetings"}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Meetings
      </Link>

      <div className="space-y-2">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          {meeting.note.title || "Granola meeting"}
        </h1>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="rounded-full border border-border/70 px-2 py-0.5 text-xs">From Granola</span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-4" />
            {meeting.at.toLocaleString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          {people.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-4" /> {people.join(", ")}
            </span>
          )}
        </p>
      </div>

      {meeting.note.body && (
        <section className="space-y-2 rounded-2xl border border-border/70 bg-card p-6">
          <h2 className="text-sm font-medium text-ink">Summary</h2>
          {/* Granola's own text, as written: its headings and bullets are plain lines. */}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{meeting.note.body}</p>
        </section>
      )}

      {meeting.note.myNotes && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-ink">My notes</h2>
          <p className="whitespace-pre-wrap rounded-2xl border border-border/70 bg-card p-5 text-sm leading-relaxed">
            {meeting.note.myNotes}
          </p>
        </section>
      )}

      {batch && (
        <NoteBatchResultView
          embedded
          batchId={batch.id}
          status={batch.status}
          anchorIso={isoDay(new Date(batch.anchorDate))}
          anchorBasis={batch.anchorBasis}
          result={batch.result}
          reminderStatus={batch.reminderStatus}
          reminderDetails={batch.reminderDetails}
          contactNames={batch.contactNames}
          contactAvatars={batch.contactAvatars}
        />
      )}
    </div>
  );
}
