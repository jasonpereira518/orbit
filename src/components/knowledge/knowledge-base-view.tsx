"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import { format } from "date-fns";
import {
  BookOpen,
  KeyRound,
  MessageSquare,
  NotebookPen,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeStats,
} from "@/lib/knowledge-base-types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Filter = "all" | KnowledgeKind;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "message", label: "Messages" },
  { id: "note", label: "Notes" },
  { id: "summary", label: "Summaries" },
  { id: "key_fact", label: "Key facts" },
  { id: "meeting", label: "Meetings" },
];

const KIND_LABEL: Record<KnowledgeKind, string> = {
  message: "LinkedIn message",
  note: "Note",
  summary: "AI summary",
  key_fact: "Key fact",
  meeting: "Meeting",
};

function KindIcon({ kind }: { kind: KnowledgeKind }) {
  const className = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  switch (kind) {
    case "message":
      return <MessageSquare className={className} />;
    case "summary":
      return <Sparkles className={className} />;
    case "key_fact":
      return <KeyRound className={className} />;
    case "meeting":
      return <Users className={className} />;
    default:
      return <NotebookPen className={className} />;
  }
}

/**
 * The Overview: every snippet Orbit holds, newest first.
 *
 * Laid out like the People view beside it: a rail on the left (search, kind filters, the
 * counts) and the list on the right, in the same card and row style. An entry opens that
 * person's dossier on this page rather than sending you to their profile, so moving between
 * the two views never means leaving the Knowledge page.
 */
export function KnowledgeBaseView({
  stats,
  entries,
}: {
  stats: KnowledgeStats;
  entries: KnowledgeEntry[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter((t) => t.length > 1);

    return entries.filter((e) => {
      if (filter !== "all" && e.kind !== filter) return false;
      if (!q) return true;
      const hay = [e.contactName, e.company, e.title, e.snippet, e.kind]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (hay.includes(q)) return true;
      return tokens.every((t) => hay.includes(t));
    });
  }, [entries, filter, query]);

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center">
        <BookOpen className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 font-[family-name:var(--font-display)] text-xl text-ink">
          Your knowledge base is empty
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Import LinkedIn connections and messages, or log notes from Capture.
          Everything you store about people shows up here and powers Chat.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Link
            href="/imports"
            className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Import LinkedIn
          </Link>
          <Link
            href="/capture"
            className="rounded-xl border border-border/70 px-4 py-2 text-sm"
          >
            Log a note
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 items-start gap-6 overflow-y-auto lg:grid-cols-[19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:overflow-hidden xl:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="space-y-3 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages, notes…"
            aria-label="Search the knowledge base"
            className="pl-9"
          />
        </div>

        <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                filter === f.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <dl className="divide-y divide-border/50 rounded-2xl border border-border/60 bg-card/40">
          <Stat icon={<Users className="h-4 w-4" />} label="People" value={stats.people} />
          <Stat icon={<MessageSquare className="h-4 w-4" />} label="Messages" value={stats.messages} />
          <Stat icon={<NotebookPen className="h-4 w-4" />} label="Notes" value={stats.notes} />
          <Stat icon={<BookOpen className="h-4 w-4" />} label="Searchable chunks" value={stats.embeddings} />
        </dl>

        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {stats.withSummary} AI summaries · {stats.withKeyFacts} people with key facts ·{" "}
          {stats.meetings} meetings. Ask about any of this in{" "}
          <Link href="/chat" className="underline-offset-2 hover:underline">
            Chat
          </Link>{" "}
          or ⌘J.
        </p>
      </aside>

      <section aria-label="Everything Orbit knows" className="flex min-w-0 flex-col gap-3 lg:min-h-0">
        <p className="px-1 text-sm text-muted-foreground">
          Showing {filtered.length} of {entries.length} items
        </p>

        <ul className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card/40 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
          {filtered.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              No matches for that search.
            </li>
          ) : (
            filtered.map((entry) => (
              <li key={entry.id}>
                <IntentLink
                  href={`/knowledge?p=${entry.contactId}`}
                  className="flex gap-3 px-3.5 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="mt-1">
                    <KindIcon kind={entry.kind} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {entry.contactName}
                      </span>
                      <Badge variant="secondary" className="text-[10px]">
                        {KIND_LABEL[entry.kind]}
                      </Badge>
                      {entry.date ? (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {format(new Date(entry.date), "MMM d, yyyy")}
                        </span>
                      ) : null}
                    </div>
                    {(entry.title || entry.company) && (
                      <p className="truncate text-xs text-muted-foreground">
                        {[entry.title, entry.company].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/80">
                      {entry.snippet}
                    </p>
                  </div>
                </IntentLink>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="ml-auto font-[family-name:var(--font-display)] text-lg leading-none text-ink">
        {value}
      </dd>
    </div>
  );
}
