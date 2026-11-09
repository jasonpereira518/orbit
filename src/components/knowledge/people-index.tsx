"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Target } from "lucide-react";
import { searchKnowledgeContent } from "@/actions/knowledge";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Input } from "@/components/ui/input";
import { IntentLink } from "@/components/ui/intent-link";
import {
  KNOWLEDGE_SEARCH_MIN_CHARS,
  type KnowledgePersonRow,
  type KnowledgeSearchHit,
} from "@/lib/knowledge-people-types";
import { cn } from "@/lib/utils";

type Sort = "recent" | "fit" | "name";

const SORTS: { id: Sort; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "fit", label: "Goal fit" },
  { id: "name", label: "A–Z" },
];

/** How long typing pauses before the notes-and-messages search runs. */
const SEARCH_DELAY_MS = 250;

/** One stable empty list, so "no hits" doesn't look like a change to the memo below. */
const NO_HITS: KnowledgeSearchHit[] = [];

/** A row, plus the stretch of text that made the content search return it. */
type Entry = { row: KnowledgePersonRow; snippet: string | null; where: string | null };

/**
 * The left pane: everyone the page loaded, searchable and sortable in the browser, plus a
 * search that reaches inside notes, messages and facts for anyone in the account.
 *
 * The instant filter covers the people already loaded (name, role, summary line). Past three
 * characters a debounced server search adds everyone whose notes, messages or facts contain
 * the words, including people beyond the loaded few hundred, and shows the matching snippet
 * in place of their summary line.
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
  const [found, setFound] = useState<{ for: string; hits: KnowledgeSearchHit[] }>({ for: "", hits: [] });

  const needle = query.trim();
  const searching = needle.length >= KNOWLEDGE_SEARCH_MIN_CHARS;

  useEffect(() => {
    if (!searching) return;
    let live = true;
    const timer = setTimeout(() => {
      searchKnowledgeContent(needle)
        .then((hits) => live && setFound({ for: needle, hits }))
        // A failed search leaves the instant filter working; it is an extra, not the list.
        .catch(() => live && setFound({ for: needle, hits: [] }));
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [needle, searching]);

  // Typing more narrows the last answer, so it stays up while the next one loads. A different
  // word does not: those results would be about something else.
  const hits =
    searching && found.for && needle.toLowerCase().startsWith(found.for.toLowerCase()) ? found.hits : NO_HITS;
  const settled = !searching || found.for === needle;

  const visible = useMemo<Entry[]>(() => {
    const tokens = needle.toLowerCase().split(/\s+/).filter(Boolean);
    const byId = new Map(hits.map((h) => [h.id, h]));
    const entries: Entry[] = [];
    for (const r of rows) {
      const hit = byId.get(r.id);
      const local = tokens.every((t) =>
        [r.fullName, r.title, r.company, r.gist].filter(Boolean).join(" ").toLowerCase().includes(t)
      );
      if (tokens.length && !local && !hit) continue;
      entries.push({ row: r, snippet: hit?.snippet ?? null, where: hit?.where ?? null });
    }
    // People the content search found who are beyond the loaded rows.
    const loaded = new Set(rows.map((r) => r.id));
    for (const h of hits) {
      if (loaded.has(h.id)) continue;
      entries.push({
        row: {
          id: h.id,
          fullName: h.fullName,
          firstName: h.firstName,
          title: h.title,
          company: h.company,
          gist: null,
          hasPhoto: h.hasPhoto,
          fitCount: 0,
          lastInteractionAt: h.lastInteractionAt,
        },
        snippet: h.snippet,
        where: h.where,
      });
    }
    if (sort === "recent") return entries; // the server's order, then the extras
    const sorted = [...entries];
    if (sort === "name") sorted.sort((a, b) => a.row.fullName.localeCompare(b.row.fullName));
    // Most goals first; ties keep the server's recency order (Array.sort is stable).
    else sorted.sort((a, b) => b.row.fitCount - a.row.fitCount);
    return sorted;
  }, [rows, hits, needle, sort]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, notes and messages"
          aria-label="Search people, notes and messages"
          className="pl-9"
        />
      </div>

      <div
        role="group"
        aria-label="Sort people"
        className="flex rounded-lg bg-muted/60 p-0.5"
      >
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={sort === s.id}
            onClick={() => setSort(s.id)}
            className={cn(
              "min-h-8 flex-1 rounded-md px-2.5 text-xs transition-colors",
              sort === s.id
                ? "bg-card font-medium text-ink shadow-sm"
                : "text-muted-foreground hover:text-foreground"
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

      <p className="sr-only" role="status" aria-live="polite">
        {searching && settled ? `${visible.length} ${visible.length === 1 ? "person" : "people"} found` : ""}
      </p>

      <ul
        aria-busy={!settled}
        className="min-h-0 divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card/40 lg:overflow-y-auto lg:overscroll-contain"
      >
        {visible.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            {settled ? "No one matches that." : "Searching…"}
          </li>
        ) : (
          visible.map(({ row: r, snippet, where }) => {
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
                          className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
                          title={`Bears on ${r.fitCount} of your goals`}
                        >
                          <Target className="h-3 w-3" aria-hidden />
                          <span aria-label={`Bears on ${r.fitCount} of your goals`}>{r.fitCount}</span>
                        </span>
                      ) : null}
                    </div>
                    {role ? <p className="truncate text-xs text-muted-foreground">{role}</p> : null}
                    {snippet ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/80">
                        <span className="font-medium text-primary">{where}: </span>
                        {snippet}
                      </p>
                    ) : (
                      <p
                        className={cn(
                          "mt-1 line-clamp-2 text-xs leading-relaxed",
                          r.gist ? "text-foreground/80" : "italic text-muted-foreground"
                        )}
                      >
                        {r.gist ?? "No summary yet"}
                      </p>
                    )}
                  </div>
                </IntentLink>
              </li>
            );
          })
        )}
      </ul>

      {total > rows.length ? (
        <p className="px-1 text-xs text-muted-foreground">
          Showing your {rows.length} most recently active people of {total}. Search reaches everyone.
        </p>
      ) : null}
    </div>
  );
}
