"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Calendar } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { IntentLink } from "@/components/ui/intent-link";
import { interactionTypeIcon, interactionTypeLabel } from "@/lib/interaction-types";
import type {
  KnowledgeTimelineItem,
  KnowledgeTimelineKind,
} from "@/lib/knowledge-timeline-types";
import { KNOWLEDGE_TIMELINE_LIMIT } from "@/lib/knowledge-timeline-types";
import { timelineDayLabel } from "@/lib/timeline-date";
import { cn } from "@/lib/utils";

type Filter = "all" | KnowledgeTimelineKind;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "message", label: "Messages" },
  { id: "note", label: "Notes" },
  { id: "meeting", label: "Meetings" },
  { id: "event", label: "Events" },
];

/** Rows shown before "Show more", and how many each press adds. */
const PAGE = 15;
/** A row longer than this gets a clamp and a "Show more". */
const CLAMP_CHARS = 220;

/** Where a row came from, for the few sources a person would recognise. */
function sourceLabel(source: string | null): string | null {
  const s = source?.toLowerCase() ?? "";
  if (s.includes("linkedin")) return "LinkedIn";
  if (s.includes("granola")) return "Granola";
  if (s.includes("calendar")) return "Calendar";
  return null;
}

/**
 * One person's history, newest first: the messages, notes, meetings and events behind the
 * summary beside it. Read-only, and plain text only — the row text is whatever was pasted or
 * imported, so it is never rendered as markup.
 */
export function DossierTimeline({
  items,
  truncated,
  name,
}: {
  items: KnowledgeTimelineItem[];
  truncated: boolean;
  name: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  // Only the kinds this person actually has, so nobody filters down to an empty list.
  const filters = useMemo(() => {
    const present = new Set(items.map((i) => i.kind));
    return present.size > 1 ? FILTERS.filter((f) => f.id === "all" || present.has(f.id)) : [];
  }, [items]);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.kind === filter)),
    [items, filter]
  );

  if (items.length === 0) {
    return (
      <EmptyState
        headingLevel={3}
        title="No history yet"
        description={`Messages, notes and meetings with ${name} will collect here as you log or import them.`}
        action={
          <>
            <IntentLink href="/capture" className="text-sm font-medium text-primary hover:underline">
              Log a note
            </IntentLink>
            <IntentLink href="/imports" className="text-sm font-medium text-primary hover:underline">
              Import messages
            </IntentLink>
          </>
        }
        className="rounded-2xl border border-dashed border-border/70"
      />
    );
  }

  const rows = visible.slice(0, shown);

  return (
    <div>
      {filters.length > 0 ? (
        <div role="group" aria-label="Filter history" className="mb-3 flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setShown(PAGE);
              }}
              className={cn(
                "min-h-8 rounded-lg px-3 text-xs transition-colors",
                filter === f.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <ol className="divide-y divide-border/50 rounded-2xl border border-border/60 bg-card/40">
        {rows.map((item) => {
          const Icon = item.type ? interactionTypeIcon(item.type) : Calendar;
          const label = item.type ? interactionTypeLabel(item.type) : (item.title ?? "Event");
          const from = sourceLabel(item.source);
          const text = item.text;
          const long = (text?.length ?? 0) > CLAMP_CHARS;
          const expanded = open.has(item.id);
          const date = new Date(item.date);
          return (
            <li key={item.id} className="flex gap-3 px-4 py-3">
              <span
                className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                aria-hidden
              >
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium text-ink">{label}</span>
                  {item.kind === "message" && item.direction ? (
                    <span className="text-xs text-muted-foreground">
                      {item.direction === "out" ? "from you" : `from ${name}`}
                    </span>
                  ) : null}
                  {from ? <span className="text-xs text-muted-foreground">{from}</span> : null}
                  <time
                    dateTime={item.date}
                    title={timelineDayLabel(date)}
                    className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
                  >
                    {format(date, "MMM d, yyyy")}
                  </time>
                </p>
                {text ? (
                  <>
                    <p
                      className={cn(
                        "mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground/90",
                        long && !expanded && "line-clamp-3"
                      )}
                    >
                      {text}
                    </p>
                    {long ? (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() =>
                          setOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                        className="mt-1 text-xs font-medium text-primary hover:underline"
                      >
                        {expanded ? "Show less" : "Show more"}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
        {visible.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing of that kind yet.</li>
        ) : null}
      </ol>

      {visible.length > shown ? (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-3 min-h-8 rounded-lg bg-muted/60 px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Show {Math.min(PAGE, visible.length - shown)} more
        </button>
      ) : truncated && filter === "all" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the latest {KNOWLEDGE_TIMELINE_LIMIT}. Older history is on {name}&rsquo;s profile.
        </p>
      ) : null}
    </div>
  );
}
