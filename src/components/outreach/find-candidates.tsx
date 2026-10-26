"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, KeyRound, Loader2, Search } from "lucide-react";
import { addProspects, skipCandidate, warmPathsForCompanies } from "@/actions/outreach-people";
import { discoverExclusions, requestBrief } from "@/components/find/request-brief";
import { WarmPathNote } from "@/components/outreach/warm-path-note";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { asLinkedInProfile } from "@/lib/outreach-channels";
import type { WarmPath } from "@/lib/warm-paths";
import type { Candidate, DiscoveryResult } from "@/lib/web-research";
import { cn } from "@/lib/utils";

type Phase = "idle" | "searching" | "done" | "no_ai" | "rate_limited" | "error";

/** Where a found person stands. No entry means they have not been acted on yet. */
type RowState =
  | { kind: "adding" | "skipping" | "added" | "on_list" | "skipped" }
  | { kind: "error"; message: string };

const SEARCH_FAILED = "The search didn’t finish — try again in a moment";

/** The key a found person is tracked by: the page that names them, and who they are. */
const keyOf = (c: Candidate) => `${c.url}|${c.fullName}`;

/** Two spellings of one found person: the same name at the same company, whatever the page. */
const sameWho = (a: Candidate, b: Candidate) =>
  a.fullName.trim().toLowerCase() === b.fullName.trim().toLowerCase() &&
  (a.company ?? "").trim().toLowerCase() === (b.company ?? "").trim().toLowerCase();

/** A found person in the shape `addProspects` and `skipCandidate` take. */
function personOf(c: Candidate) {
  return {
    fullName: c.fullName,
    title: c.title,
    company: c.company,
    whyMatches: c.whyMatches,
    url: c.url,
    // Their LinkedIn page is the best anchor there is, so it is kept when that is what found them.
    linkedinUrl: asLinkedInProfile(c.url),
    origin: "find" as const,
  };
}

/** The HTTP status a failed request carries, if it carries one (see `BriefError`). */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Web search for the people a campaign is aimed at: a handful of candidates, each added to the
 * list or passed on with one click. Nobody becomes a contact here; that happens at send time.
 */
export function FindCandidates({
  campaignId,
  audienceQuery,
  knownNames,
  canUseAi = true,
}: {
  campaignId: string;
  audienceQuery: string;
  /** Everyone the campaign has ever listed, newest first. "Find more" asks the search to skip them. */
  knownNames: string[];
  canUseAi?: boolean;
}) {
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>(canUseAi ? "idle" : "no_ai");
  const [message, setMessage] = useState("");
  const [found, setFound] = useState<Candidate[]>([]);
  const [quiet, setQuiet] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [warmPaths, setWarmPaths] = useState<Record<string, WarmPath[]>>({});
  const [announcement, setAnnouncement] = useState("");
  // Each search takes a number; an answer that comes back after a newer search started (or
  // after this is gone) is not the one on screen, so it is dropped.
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ticket;
    return () => {
      mine.current += 1;
    };
  }, []);

  const rowEls = useRef(new Map<string, HTMLLIElement>());

  const searching = phase === "searching";
  const setRow = (c: Candidate, state: RowState) => setRows((all) => ({ ...all, [keyOf(c)]: state }));
  /**
   * The button just pressed turns disabled, then is replaced by a word, and focus would drop to
   * the page. Parking it on the row keeps a keyboard user's place in the list.
   */
  const keepFocus = (c: Candidate) => rowEls.current.get(keyOf(c))?.focus();

  async function search() {
    const mine = ++ticket.current;
    setPhase("searching");
    setMessage("");
    // The people already on screen come first, then everyone the campaign knows; on the first
    // search that is just the campaign's own people, so a returning visit doesn’t re-offer them.
    const exclude = discoverExclusions(
      found.map((c) => c.fullName),
      knownNames
    );
    try {
      const { dossier } = await requestBrief<DiscoveryResult>({
        kind: "discover",
        query: audienceQuery,
        ...(exclude.length ? { exclude } : {}),
      });
      if (mine !== ticket.current) return;
      const fresh = dossier.candidates.filter((c) => !found.some((f) => sameWho(f, c)));
      setFound([...found, ...fresh]);
      setQuiet(fresh.length === 0);
      setPhase("done");
      // A quiet result is already said in words below; a list appearing is not.
      setAnnouncement(fresh.length ? `${fresh.length} ${fresh.length === 1 ? "person" : "people"} found` : "");
      void lookUpWarmPaths(fresh);
    } catch (err) {
      if (mine !== ticket.current) return;
      const status = statusOf(err);
      if (status === 402) {
        setPhase("no_ai");
      } else {
        setPhase(status === 429 ? "rate_limited" : "error");
        setMessage(friendlyError(err, SEARCH_FAILED));
      }
    }
  }

  /**
   * One lookup for the companies just shown. It is keyed by company, so an answer is good
   * whenever it lands and is merged rather than ticketed; a failure only means no note.
   */
  async function lookUpWarmPaths(people: Candidate[]) {
    const companies = [...new Set(people.map((c) => c.company?.trim()).filter((c): c is string => Boolean(c)))];
    if (!companies.length) return;
    try {
      const res = await warmPathsForCompanies(companies);
      if (res.ok) setWarmPaths((all) => ({ ...all, ...res.value }));
    } catch {
      // A bonus on top of the list, not part of it.
    }
  }

  async function add(c: Candidate) {
    keepFocus(c);
    setRow(c, { kind: "adding" });
    try {
      const res = await addProspects(campaignId, [personOf(c)]);
      if (!res.ok) return setRow(c, { kind: "error", message: res.error });
      const { added, alreadyThere } = res.value;
      if (added) {
        setRow(c, { kind: "added" });
        setAnnouncement(`Added ${c.fullName}`);
      } else if (alreadyThere) {
        // Someone put back from skipped lands here too: they are on the list now.
        setRow(c, { kind: "on_list" });
        setAnnouncement(`${c.fullName} is on the list`);
      } else {
        setRow(c, { kind: "error", message: "Needs a company or a LinkedIn link — use Add someone instead" });
      }
    } catch (err) {
      setRow(c, { kind: "error", message: friendlyError(err, "Couldn’t add them — try again?") });
    }
  }

  async function skip(c: Candidate) {
    keepFocus(c);
    setRow(c, { kind: "skipping" });
    try {
      const res = await skipCandidate(campaignId, personOf(c));
      if (!res.ok) return setRow(c, { kind: "error", message: res.error });
      setRow(c, { kind: "skipped" });
      setAnnouncement(`Skipped ${c.fullName}`);
    } catch (err) {
      setRow(c, { kind: "error", message: friendlyError(err, "Couldn’t skip them — try again?") });
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-medium text-ink">
            Find people
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {audienceQuery.trim()
              ? `Searches the web for “${audienceQuery.trim()}”. You’ll get a handful of people, not a complete list.`
              : "This campaign has no description of who to reach, so there is nothing to search for. Add people by hand below."}
          </p>
        </div>
        <Button onClick={search} disabled={searching || !canUseAi || !audienceQuery.trim()}>
          {searching ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}
          {searching ? "Searching…" : found.length ? "Find more" : "Find people"}
        </Button>
      </div>

      {/* Everything the search has to say lands here, so it is announced rather than just drawn. */}
      <div role="status" className="text-sm">
        {searching && <p className="text-muted-foreground">Searching the web — this can take a minute</p>}
        {phase === "no_ai" && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-amber-900 dark:text-amber-200">
            <KeyRound className="size-4 shrink-0" aria-hidden />
            <span>Finding people runs a web search on your AI provider. Add a key to start.</span>
            <Link href="/settings?section=ai" className="font-medium underline underline-offset-4">
              Add AI key
            </Link>
          </p>
        )}
        {(phase === "rate_limited" || phase === "error") && (
          <p className={phase === "error" ? "text-destructive" : "text-muted-foreground"}>{message}</p>
        )}
        {phase === "done" && quiet && (
          <p className="text-muted-foreground">
            {found.length
              ? "No one new turned up this time."
              : "Nobody clearly matching turned up. Try again later, or add someone yourself."}
          </p>
        )}
        <p className="sr-only">{announcement}</p>
      </div>

      {found.length > 0 && (
        <ul className="divide-y divide-border/60">
          {found.map((c) => {
            const state = rows[keyOf(c)];
            const busy = state?.kind === "adding" || state?.kind === "skipping";
            const settled = state?.kind === "added" || state?.kind === "on_list" || state?.kind === "skipped";
            return (
              <li
                key={keyOf(c)}
                ref={(el) => {
                  if (el) rowEls.current.set(keyOf(c), el);
                  else rowEls.current.delete(keyOf(c));
                }}
                tabIndex={-1}
                className={cn("py-3 outline-none", state?.kind === "skipped" && "opacity-60")}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{c.fullName}</p>
                    {(c.title || c.company) && (
                      <p className="text-xs text-muted-foreground">{[c.title, c.company].filter(Boolean).join(" · ")}</p>
                    )}
                    <p className="mt-0.5 text-xs text-ink/80">{c.whyMatches}</p>
                    <WarmPathNote company={c.company} warmPaths={warmPaths} />
                  </div>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-ink"
                    aria-label={`Where ${c.fullName} was found (opens in a new tab)`}
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                  {settled ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                      {state.kind !== "skipped" && <Check className="size-4" aria-hidden />}
                      {state.kind === "added" ? "Added" : state.kind === "on_list" ? "On the list" : "Skipped"}
                    </span>
                  ) : (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" disabled={busy} onClick={() => add(c)}>
                        {state?.kind === "adding" ? "Adding…" : "Add"}
                        <span className="sr-only"> {c.fullName}</span>
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => skip(c)}>
                        {state?.kind === "skipping" ? "Skipping…" : "Skip"}
                        <span className="sr-only"> {c.fullName}</span>
                      </Button>
                    </div>
                  )}
                </div>
                {state?.kind === "error" && (
                  <p role="alert" className="mt-1.5 text-xs text-destructive">
                    {state.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
