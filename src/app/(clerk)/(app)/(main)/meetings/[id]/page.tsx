import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Link from "next/link";
import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Clock, Users } from "lucide-react";
import { RenderStamp } from "@/components/layout/render-stamp";
import { formatMeetingDuration } from "@/lib/format-meeting-duration";
import { requireUserId } from "@/lib/auth";
import { formatElapsed } from "@/lib/format-elapsed";
import { speakerLabel, speakerNames } from "@/lib/meeting-digest";
import { getMeetingTranscript } from "@/lib/meeting-sessions";
import { MeetingRecapButton } from "@/components/meetings/meeting-recap-button";
import { isSurfaceLive } from "@/lib/surface-visibility";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

const SEARCH_MAX = 100;

/** Request-memoized so `generateMetadata` and the page share one read. */
const loadMeetingTranscript = cache((userId: string, id: string) => getMeetingTranscript(userId, id));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const meeting = await loadMeetingTranscript(await requireUserId(), id);
    if (!meeting || (meeting.session.status !== "analyzed" && meeting.session.status !== "saved")) {
      return { title: "Meeting" };
    }
    const { session } = meeting;
    return { title: session.title?.trim() || session.digest?.title?.trim() || "Untitled meeting" };
  } catch {
    return { title: "Meeting" };
  }
}

/** Splits `text` around case-insensitive occurrences of `q`, marking each. */
function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export default async function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const gate = await pageVisibilityGate("page.meetings");
  if (gate) return gate;

  const { id } = await params;
  const q = ((await searchParams).q ?? "").trim().slice(0, SEARCH_MAX);
  const userId = await requireUserId();

  const [meeting, composeLive] = await Promise.all([
    loadMeetingTranscript(userId, id),
    isSurfaceLive(userId, COMPOSE_SURFACE_KEY).catch(() => false),
  ]);
  // The same two states the list shows. A meeting still being recorded is Capture's.
  if (!meeting || (meeting.session.status !== "analyzed" && meeting.session.status !== "saved")) notFound();

  const { session, segments, missingSeqs } = meeting;
  const digest = session.digest;
  const title = session.title?.trim() || digest?.title?.trim() || "Untitled meeting";
  const guests = (session.attendees ?? []).map((a) => a.name);
  // The same 1:1 rule the summary used: one guest and one other voice is that guest.
  const voices = speakerNames(segments, guests);

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
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">{title}</h1>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-4" />
            {session.startedAt.toLocaleString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-4" /> {formatMeetingDuration(session.durationMs)}
          </span>
          {guests.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-4" /> {guests.join(", ")}
            </span>
          )}
        </p>
        {session.noteBatchId && (
          <Link
            href={`/capture/${session.noteBatchId}`}
            className="inline-block text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            See what was saved from this meeting →
          </Link>
        )}
      </div>

      {digest && <MeetingRecapButton sessionId={session.id} composeLive={composeLive} />}

      {digest ? (
        <div className="space-y-5 rounded-2xl border border-border/70 bg-card p-6">
          <p className="text-sm leading-relaxed text-foreground">{digest.summary}</p>
          <Section title="Key points" items={digest.keyPoints} />
          <Section title="Decisions" items={digest.decisions} />
          <Section
            title="Action items"
            items={digest.actionItems.map((a) => (a.owner ? `${a.text} — ${a.owner === "me" ? "you" : a.owner}` : a.text))}
          />
          <Section title="Blockers" items={digest.blockers.map((b) => b.text)} />
          <Section title="Open questions" items={digest.openQuestions.map((o) => o.text)} />
          {digest.agenda && digest.agenda.length > 0 && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-medium text-ink">
                Agenda <span className="font-normal text-muted-foreground">· from the invite</span>
              </h2>
              <ul className="space-y-1 text-sm">
                {digest.agenda.map((a, i) => (
                  <li key={i} className={a.covered ? "text-foreground" : "text-muted-foreground"}>
                    <span aria-hidden className="mr-1.5">{a.covered ? "✓" : "○"}</span>
                    {a.item}
                    {!a.covered && <span className="sr-only"> (not covered)</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-ink">Transcript</h2>
        {missingSeqs.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-warning">
            {missingSeqs.length} part{missingSeqs.length === 1 ? "" : "s"} of this transcript never reached Orbit, so
            some of what was said may be missing.
          </p>
        )}
        {segments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was transcribed.</p>
        ) : (
          <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-5 text-sm">
            {segments
              .filter((s) => s.text.trim())
              .map((s) => {
                const who = (s.speaker && voices.get(s.speaker)) || speakerLabel(s.speaker);
                return (
                  <p key={s.seq} className="leading-relaxed">
                    <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatElapsed(s.startMs)}
                    </span>
                    {who && <span className="mr-1.5 font-medium text-foreground">{who}:</span>}
                    <Highlighted text={s.text} q={q} />
                  </p>
                );
              })}
          </div>
        )}
      </section>
    </div>
  );
}
