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
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ROW_HOVER } from "@/lib/interaction";
import { cn } from "@/lib/utils";

type Filter = "all" | KnowledgeKind;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "message", label: "Messages" },
  { key: "note", label: "Notes" },
  { key: "summary", label: "Summaries" },
  { key: "key_fact", label: "Key facts" },
  { key: "meeting", label: "Meetings" },
];

const KIND_LABEL: Record<KnowledgeKind, string> = {
  message: "LinkedIn message",
  note: "Note",
  summary: "AI summary",
  key_fact: "Key fact",
  meeting: "Meeting",
};

function KindIcon({ kind }: { kind: KnowledgeKind }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
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
      <EmptyState
        icon={BookOpen}
        title="Your knowledge base is empty"
        description="Import LinkedIn connections and messages, or log notes from Capture. Everything you store about people shows up here and powers Chat."
        action={
          <>
            <Link href="/imports" className={buttonVariants()}>
              Import LinkedIn
            </Link>
            <Link href="/capture" className={buttonVariants({ variant: "outline" })}>
              Log a note
            </Link>
          </>
        }
      />
    );
  }

  return (
    <div className="grid min-h-0 flex-1 items-start gap-6 overflow-y-auto lg:grid-cols-[19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:overflow-hidden xl:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="space-y-3 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages, notes…"
            aria-label="Search the knowledge base"
            className="pl-9"
          />
        </div>

        {/* Six short labels in a 19rem rail: the track wraps rather than overflowing. */}
        <SegmentedControl
          items={FILTERS}
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter by kind"
          variant="subtle"
          size="sm"
          className="flex-wrap"
        />

        <dl className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-card">
          <Stat icon={<Users className="size-4" aria-hidden />} label="People" value={stats.people} />
          <Stat icon={<MessageSquare className="size-4" aria-hidden />} label="Messages" value={stats.messages} />
          <Stat icon={<NotebookPen className="size-4" aria-hidden />} label="Notes" value={stats.notes} />
          <Stat icon={<BookOpen className="size-4" aria-hidden />} label="Searchable chunks" value={stats.embeddings} />
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

        <ul className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-card lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
          {filtered.length === 0 ? (
            <li>
              <EmptyState variant="plain" size="sm" title="No matches for that search" />
            </li>
          ) : (
            filtered.map((entry) => (
              <li key={entry.id}>
                <IntentLink
                  href={`/knowledge?p=${entry.contactId}`}
                  className={cn("flex gap-3 px-4 py-3", ROW_HOVER)}
                >
                  <div className="mt-1">
                    <KindIcon kind={entry.kind} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {entry.contactName}
                      </span>
                      <Badge tone="neutral" size="sm">
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
    <div className="flex items-center gap-2 px-4 py-2.5">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="ml-auto font-heading text-lg leading-none text-ink">
        {value}
      </dd>
    </div>
  );
}
