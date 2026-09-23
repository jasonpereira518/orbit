"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";
import { saveApolloLeadAction, searchApolloLeadsAction } from "@/actions/leads";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import {
  APOLLO_MAX_PAGE,
  type ApolloLeadRow,
  type ApolloLeadSearch,
  type ApolloSearchInput,
} from "@/lib/leads/apollo-leads";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PathSummary } from "./path-summary";
import { WarmthChip } from "./warmth-chip";

const EMPTY: ApolloSearchInput = { titles: "", companies: "", locations: "", keywords: "" };

const FIELDS: { key: keyof ApolloSearchInput; label: string; placeholder: string }[] = [
  { key: "titles", label: "Titles", placeholder: "VP Sales, Head of Partnerships" },
  { key: "companies", label: "Companies", placeholder: "Northwind, Lumen Labs" },
  { key: "locations", label: "Locations", placeholder: "New York, Remote" },
  { key: "keywords", label: "Keywords", placeholder: "fintech" },
];

const TEAM_NOTE = {
  no_team: "Join your team to see who knows these people.",
  not_sharing: "Share your network to see who knows these people.",
} as const;

/**
 * Apollo prospecting with the team's warm paths on every result. Collapsed by default: it is
 * the second way into the pipeline, after Find a path. Without an Apollo key `searchPeople`
 * returns invented people; the notice says so rather than letting them pass for real ones.
 */
export function ApolloSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<ApolloSearchInput>(EMPTY);
  const [result, setResult] = useState<ApolloLeadSearch | null>(null);
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();

  function run(page: number) {
    startSearch(async () => {
      try {
        const res = await searchApolloLeadsAction(input, page);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setResult((prev) => (page > 1 && prev ? { ...res.value, rows: [...prev.rows, ...res.value.rows] } : res.value));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t search Apollo — try again?"));
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(1);
  }

  function save(row: ApolloLeadRow) {
    startSave(async () => {
      try {
        const res = await saveApolloLeadAction(row.prospect);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setSaved((prev) => new Set(prev).add(row.prospect.externalId));
        toast.success(
          res.value.created
            ? `${row.prospect.fullName} saved to your leads`
            : `${row.prospect.fullName} is already in your leads`
        );
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save that lead — try again?"));
      }
    });
  }

  const hasMore = result ? result.rows.length < result.total && result.page < APOLLO_MAX_PAGE : false;

  return (
    <section className="rounded-2xl border border-border/70 bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="apollo-search-panel"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span>
          <span className="block font-medium text-ink">Search Apollo</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            Find new people by title and company, and see which ones your team already knows.
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-fast", open && "rotate-180")}
        />
      </button>

      {open && (
        <div id="apollo-search-panel" className="space-y-4 border-t border-border/60 p-5">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`apollo-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`apollo-${field.key}`}
                    value={input[field.key]}
                    placeholder={field.placeholder}
                    maxLength={300}
                    onChange={(event) => setInput((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
            <Button type="submit" disabled={searching}>
              <Search aria-hidden />
              {searching ? "Searching…" : "Search"}
            </Button>
          </form>

          {result && (
            <div className="space-y-3" aria-live="polite">
              {result.source === "demo" && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  Demo results — add your Apollo key in Settings to search real people. Warm paths
                  still work on them.
                </p>
              )}
              {result.team !== "ok" && <p className="text-xs text-muted-foreground">{TEAM_NOTE[result.team]}</p>}
              {result.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody matched — try fewer filters.</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
                  {result.rows.map((row) => {
                    const done = saved.has(row.prospect.externalId);
                    return (
                      <li key={row.prospect.externalId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-ink">{row.prospect.fullName}</p>
                          <p className="truncate text-sm text-muted-foreground">
                            {[row.prospect.title, row.prospect.company, row.prospect.location].filter(Boolean).join(" · ")}
                          </p>
                          {row.path && <PathSummary path={row.path} companyName={row.prospect.company} compact />}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {row.path ? <WarmthChip warmth={row.path.warmth} /> : null}
                          <Button type="button" size="sm" variant="outline" disabled={saving || done} onClick={() => save(row)}>
                            {done ? "Saved" : "Save"}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {hasMore && (
                <Button type="button" variant="ghost" size="sm" disabled={searching} onClick={() => run(result.page + 1)}>
                  {searching ? "Loading…" : "More results"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
