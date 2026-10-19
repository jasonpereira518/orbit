"use client";

import { useMemo, useState } from "react";
import { Search, Target } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { IntentLink } from "@/components/ui/intent-link";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ROW_HOVER } from "@/lib/interaction";
import type { KnowledgePersonRow } from "@/lib/knowledge-people-types";
import { cn } from "@/lib/utils";

type Sort = "recent" | "fit" | "name";

const SORTS: { key: Sort; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "fit", label: "Goal fit" },
  { key: "name", label: "A–Z" },
];

/**
 * The left pane: everyone the page loaded, searchable and sortable in the browser.
 *
 * Selection is the URL (`?p=`), not component state, so a dossier is a link you can share,
 * reload, and reach with back/forward — and so the dossier itself can be a server component
 * that streams in behind a skeleton. Rows are `IntentLink`s, so hovering one prefetches the
 * dossier and the click lands without a skeleton.
 */
export function PeopleIndex({
  rows,
  total,
  goalCount,
  selectedId,
}: {
  rows: KnowledgePersonRow[];
  total: number;
  goalCount: number;
  selectedId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const matched = tokens.length
      ? rows.filter((r) => {
          const hay = [r.fullName, r.title, r.company, r.gist].filter(Boolean).join(" ").toLowerCase();
          return tokens.every((t) => hay.includes(t));
        })
      : rows;
    if (sort === "recent") return matched; // the server's order
    const sorted = [...matched];
    if (sort === "name") sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
    // Most goals first; ties keep the server's recency order (Array.sort is stable).
    else sorted.sort((a, b) => b.fitCount - a.fitCount);
    return sorted;
  }, [rows, query, sort]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          aria-label="Search people"
          className="pl-9"
        />
      </div>

      <SegmentedControl items={SORTS} value={sort} onChange={setSort} ariaLabel="Sort people" variant="subtle" size="sm" />

      {sort === "fit" && goalCount === 0 ? (
        <p className="rounded-lg border border-border-subtle bg-surface-inset px-3 py-2 text-xs text-muted-foreground">
          Goal fit needs a goal to measure against.{" "}
          <IntentLink href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
            Add one in Settings
          </IntentLink>
          .
        </p>
      ) : null}

      <ul className="min-h-0 divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-card lg:overflow-y-auto lg:overscroll-contain">
        {visible.length === 0 ? (
          <li>
            <EmptyState variant="plain" size="sm" title="No one matches that" />
          </li>
        ) : (
          visible.map((r) => {
            const selected = r.id === selectedId;
            const role = [r.title, r.company].filter(Boolean).join(" · ");
            return (
              <li key={r.id}>
                <IntentLink
                  href={`/knowledge?p=${r.id}`}
                  aria-current={selected ? "true" : undefined}
                  className={cn("flex gap-3 px-4 py-3", ROW_HOVER, selected && "bg-accent hover:bg-accent")}
                >
                  <ContactAvatar
                    contactId={r.id}
                    firstName={r.firstName}
                    fullName={r.fullName}
                    resolveOnDemand={r.hasPhoto}
                    size="sm"
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{r.fullName}</span>
                      {r.fitCount > 0 ? (
                        <Badge tone="accent" size="sm" className="ml-auto" title={`Bears on ${r.fitCount} of your goals`}>
                          <Target aria-hidden />
                          <span aria-label={`Bears on ${r.fitCount} of your goals`}>{r.fitCount}</span>
                        </Badge>
                      ) : null}
                    </div>
                    {role ? <p className="truncate text-xs text-muted-foreground">{role}</p> : null}
                    <p
                      className={cn(
                        "mt-1 line-clamp-2 text-xs leading-relaxed",
                        r.gist ? "text-foreground/80" : "italic text-muted-foreground"
                      )}
                    >
                      {r.gist ?? "No summary yet"}
                    </p>
                  </div>
                </IntentLink>
              </li>
            );
          })
        )}
      </ul>

      {total > rows.length ? (
        <p className="px-1 text-xs text-muted-foreground">
          Showing your {rows.length} most recently active people of {total}.
        </p>
      ) : null}
    </div>
  );
}
