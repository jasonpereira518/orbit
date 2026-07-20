"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { searchDashboardContacts } from "@/actions/search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MATCHED_FIELD_LABELS,
  type KeywordSearchHit,
} from "@/lib/keyword-search";
import { cn } from "@/lib/utils";

export function DashboardCommandSearch() {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KeywordSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const debounceRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById(inputId)?.focus();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputId]);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        // Keep panel open while typing results exist; only close if empty query
        if (!query.trim()) setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [query]);

  function runSearch(value: string) {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      start(async () => {
        if (!value.trim()) {
          setResults([]);
          return;
        }
        const hits = await searchDashboardContacts(value);
        setResults(hits);
        setOpen(true);
      });
    }, 180);
  }

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border border-border/70 bg-card/90 px-3 py-2 shadow-sm backdrop-blur",
          "focus-within:border-primary/35 focus-within:ring-[3px] focus-within:ring-primary/15"
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input
          id={inputId}
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            runSearch(next);
            if (next.trim()) setOpen(true);
          }}
          onFocus={() => {
            if (query.trim() || results.length) setOpen(true);
          }}
          placeholder="Search your network…"
          className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          autoComplete="off"
        />
        <kbd className="hidden rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
          ⌘K
        </kbd>
        {(query || open) && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setResults([]);
              setOpen(false);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {open && query.trim() && (
        <div
          className={cn(
            "absolute left-0 right-0 top-[calc(100%+0.5rem)] z-40 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-lg",
            "md:left-auto md:right-0 md:w-[min(100%,24rem)]"
          )}
        >
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {pending ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>

          {results.length === 0 && !pending ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No people matched “{query.trim()}”.
            </p>
          ) : (
            <ul className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
              {results.map((hit) => (
                <li key={hit.id}>
                  <Link
                    href={`/contacts/${hit.id}`}
                    className="block rounded-xl px-3 py-3 transition-colors hover:bg-muted/60"
                    onClick={() => setOpen(false)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-primary">
                          {hit.preferredName || hit.fullName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[hit.title, hit.company].filter(Boolean).join(" · ") ||
                            "No role yet"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {hit.source === "semantic" && (
                          <Badge variant="secondary" className="text-[10px]">
                            AI
                          </Badge>
                        )}
                        {hit.source === "hybrid" && (
                          <Badge variant="secondary" className="text-[10px]">
                            AI+text
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {Math.round(hit.score * 100)}
                        </Badge>
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {hit.explanation}
                    </p>
                    {hit.matchedFields.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {hit.matchedFields.slice(0, 4).map((field) => (
                          <Badge
                            key={field}
                            variant="secondary"
                            className="text-[10px] capitalize"
                          >
                            {MATCHED_FIELD_LABELS[field]}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
