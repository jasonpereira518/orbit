"use client";

import { useState, useTransition } from "react";
import { ChevronDown, CircleHelp, Construction, ListTodo } from "lucide-react";
import { loadMeetingTranscript, type MeetingTranscriptView } from "@/actions/meetings";
import type { NoteBatchMeeting } from "@/db/schema";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatElapsed } from "@/lib/voice-recording";
import { cn } from "@/lib/utils";

export type MeetingItemKind = "action" | "blocker" | "question";

/** One digest item the user can turn into a reminder while reviewing a meeting. */
export type SelectableMeetingItem = {
  key: string;
  kind: MeetingItemKind;
  text: string;
  owner: string | null;
  sourceExcerpt: string | null;
  checked: boolean;
  /** The reminder title, editable once checked. Starts as `text`. */
  title: string;
};

type MeetingSummary = Pick<
  NoteBatchMeeting,
  "title" | "summary" | "keyPoints" | "decisions" | "durationMs" | "startedAtIso"
> & {
  actionItems: { text: string; owner: string | null }[];
  blockers: { text: string; owner: string | null }[];
  openQuestions: { text: string; askedBy: string | null }[];
};

export function formatMeetingDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * What a recorded meeting was: summary, decisions, and the three lists no per-person card
 * can carry — action items, blockers, open questions.
 *
 * Read-only on the results page. With `items` + `onItemsChange` (the capture review), the
 * three lists become checkable — "make a reminder" — with the title editable once ticked.
 */
export function MeetingSummaryCard({
  meeting,
  items,
  onItemsChange,
  sessionId,
  className,
}: {
  meeting: MeetingSummary;
  items?: SelectableMeetingItem[];
  onItemsChange?: (next: SelectableMeetingItem[]) => void;
  /** When set, offers the full transcript behind a disclosure. */
  sessionId?: string | null;
  className?: string;
}) {
  const date = new Date(meeting.startedAtIso);
  const dateLabel = Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const selectable = Boolean(items && onItemsChange);

  const list = (kind: MeetingItemKind) =>
    selectable
      ? items!.filter((i) => i.kind === kind)
      : (kind === "action"
          ? meeting.actionItems.map((a) => ({ text: a.text, owner: a.owner }))
          : kind === "blocker"
            ? meeting.blockers.map((b) => ({ text: b.text, owner: b.owner }))
            : meeting.openQuestions.map((q) => ({ text: q.text, owner: q.askedBy }))
        ).map((i, index) => ({
          key: `${kind}:${index}`,
          kind,
          text: i.text,
          owner: i.owner,
          sourceExcerpt: null,
          checked: false,
          title: i.text,
        }));

  const update = (key: string, patch: Partial<SelectableMeetingItem>) =>
    onItemsChange?.(items!.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  return (
    <section
      className={cn("space-y-4 rounded-2xl border border-border/70 bg-card p-5 sm:p-6", className)}
      aria-label="Meeting summary"
    >
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Meeting{dateLabel ? ` · ${dateLabel}` : ""} · {formatMeetingDuration(meeting.durationMs)}
        </p>
        <h2 className="text-lg font-medium text-ink">{meeting.title}</h2>
        {meeting.summary && <p className="text-sm leading-relaxed text-foreground/90">{meeting.summary}</p>}
      </header>

      {(meeting.keyPoints.length > 0 || meeting.decisions.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {meeting.keyPoints.length > 0 && <Bullets title="Key points" items={meeting.keyPoints} />}
          {meeting.decisions.length > 0 && <Bullets title="Decisions" items={meeting.decisions} />}
        </div>
      )}

      <ItemGroup
        title="Action items"
        icon={<ListTodo className="size-4" />}
        items={list("action")}
        ownerLabel="Owner"
        selectable={selectable}
        onUpdate={update}
      />
      <ItemGroup
        title="Blockers"
        icon={<Construction className="size-4" />}
        items={list("blocker")}
        ownerLabel="Owner"
        selectable={selectable}
        onUpdate={update}
      />
      <ItemGroup
        title="Open questions"
        icon={<CircleHelp className="size-4" />}
        items={list("question")}
        ownerLabel="Asked by"
        selectable={selectable}
        onUpdate={update}
      />

      {selectable && (
        <p className="text-xs text-muted-foreground">
          Tick anything you want a reminder for. Action items for the people you save below get
          their own reminders automatically.
        </p>
      )}

      {sessionId && <TranscriptDisclosure sessionId={sessionId} />}
    </section>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ItemGroup({
  title,
  icon,
  items,
  ownerLabel,
  selectable,
  onUpdate,
}: {
  title: string;
  icon: React.ReactNode;
  items: SelectableMeetingItem[];
  ownerLabel: string;
  selectable: boolean;
  onUpdate: (key: string, patch: Partial<SelectableMeetingItem>) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
        <span className="text-muted-foreground">{icon}</span>
        {title}
        <span className="font-normal text-muted-foreground">({items.length})</span>
      </h3>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key} className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-sm">
            <div className="flex items-start gap-2.5">
              {selectable && (
                <Checkbox
                  className="mt-0.5"
                  checked={item.checked}
                  aria-label={`Make a reminder: ${item.text}`}
                  onCheckedChange={(v) => onUpdate(item.key, { checked: Boolean(v) })}
                />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p>{item.text}</p>
                {item.owner && (
                  <p className="text-xs text-muted-foreground">
                    {ownerLabel}: {item.owner === "me" ? "You" : item.owner}
                  </p>
                )}
                {selectable && item.checked && (
                  <Input
                    value={item.title}
                    aria-label="Reminder title"
                    className="h-8 text-sm"
                    onChange={(e) => onUpdate(item.key, { title: e.target.value })}
                  />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The whole transcript, fetched only when opened — an hour is ~55k characters. */
function TranscriptDisclosure({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<MeetingTranscriptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="border-t border-border/60 pt-3">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium text-primary"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !transcript) {
            start(async () => {
              const res = await loadMeetingTranscript(sessionId);
              if (res.ok) setTranscript(res.transcript);
              else setError(res.error);
            });
          }
        }}
      >
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        {open ? "Hide transcript" : "Show transcript"}
      </button>
      {open && (
        <div className="mt-3 max-h-96 space-y-3 overflow-y-auto pr-1 text-sm">
          {pending && <p className="text-muted-foreground">Loading…</p>}
          {error && <p className="text-destructive">{error}</p>}
          {transcript?.segments
            .filter((s) => s.text.trim())
            .map((s) => (
              <p key={s.seq} className="leading-relaxed">
                <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
                  {formatElapsed(s.startMs)}
                </span>
                {s.text}
              </p>
            ))}
          {transcript && transcript.segments.every((s) => !s.text.trim()) && (
            <p className="text-muted-foreground">Nothing was transcribed.</p>
          )}
        </div>
      )}
    </div>
  );
}
