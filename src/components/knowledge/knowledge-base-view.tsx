"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
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
} from "@/actions/knowledge";
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

  const empty = entries.length === 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<Users className="h-4 w-4" />}
          label="People"
          value={stats.people}
        />
        <Stat
          icon={<MessageSquare className="h-4 w-4" />}
          label="Messages"
          value={stats.messages}
        />
        <Stat
          icon={<NotebookPen className="h-4 w-4" />}
          label="Notes"
          value={stats.notes}
        />
        <Stat
          icon={<BookOpen className="h-4 w-4" />}
          label="Searchable chunks"
          value={stats.embeddings}
        />
      </div>

      <p className="text-sm text-muted-foreground">
        {stats.withSummary} AI summaries · {stats.withKeyFacts} people with key
        facts · {stats.meetings} meetings. Ask about any of this in{" "}
        <Link href="/chat" className="underline-offset-2 hover:underline">
          Chat
        </Link>{" "}
        or ⌘K.
      </p>

      {empty ? (
        <div className="rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center">
          <BookOpen className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-xl text-primary">
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
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people, messages, notes…"
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
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
          </div>

          <p className="text-sm text-muted-foreground">
            Showing {filtered.length} of {entries.length} items
          </p>

          <ul className="divide-y divide-border/50 rounded-2xl border border-border/60">
            {filtered.length === 0 ? (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                No matches for that search.
              </li>
            ) : (
              filtered.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={`/contacts/${entry.contactId}`}
                    className="flex gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40"
                  >
                    <div className="mt-1">
                      <KindIcon kind={entry.kind} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-primary">
                          {entry.contactName}
                        </span>
                        <Badge variant="secondary" className="text-[10px]">
                          {KIND_LABEL[entry.kind]}
                        </Badge>
                        {entry.date ? (
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(entry.date), "MMM d, yyyy")}
                          </span>
                        ) : null}
                      </div>
                      {(entry.title || entry.company) && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {[entry.title, entry.company]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                      <p className="mt-1.5 line-clamp-2 text-sm text-foreground/90">
                        {entry.snippet}
                      </p>
                    </div>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 font-[family-name:var(--font-display)] text-2xl text-primary">
        {value}
      </p>
    </div>
  );
}
