"use client";

import { useMemo, useState } from "react";
import { Search, Target } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Input } from "@/components/ui/input";
import { IntentLink } from "@/components/ui/intent-link";
import type { KnowledgePersonRow } from "@/lib/knowledge-people-types";
import { cn } from "@/lib/utils";

type Sort = "recent" | "fit" | "name";

const SORTS: { id: Sort; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "fit", label: "Goal fit" },
  { id: "name", label: "A–Z" },
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
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          aria-label="Search people"
          className="pl-9"
        />
      </div>

      <div role="group" aria-label="Sort people" className="flex gap-1.5">
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={sort === s.id}
            onClick={() => setSort(s.id)}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-xs transition-colors",
              sort === s.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sort === "fit" && goalCount === 0 ? (
        <p className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Goal fit needs a goal to measure against.{" "}
          <IntentLink href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
            Add one in Settings
          </IntentLink>
          .
        </p>
      ) : null}

      <ul className="min-h-0 divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card/40 lg:overflow-y-auto lg:overscroll-contain">
        {visible.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">No one matches that.</li>
        ) : (
          visible.map((r) => {
            const selected = r.id === selectedId;
            const role = [r.title, r.company].filter(Boolean).join(" · ");
            return (
              <li key={r.id}>
                <IntentLink
                  href={`/knowledge?p=${r.id}`}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex gap-3 px-3.5 py-3 transition-colors hover:bg-muted/40",
                    selected && "bg-accent hover:bg-accent"
                  )}
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
                        <span
                          className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                          title={`Bears on ${r.fitCount} of your goals`}
                        >
                          <Target className="h-3 w-3" aria-hidden />
                          <span aria-label={`Bears on ${r.fitCount} of your goals`}>{r.fitCount}</span>
                        </span>
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
