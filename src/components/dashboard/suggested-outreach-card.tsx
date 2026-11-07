"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getPeopleToMeet, saveResearchedPerson } from "@/actions/web-research";
import { SuggestionRow } from "@/components/dashboard/suggestion-row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LINKEDIN_PROFILE, requestBrief } from "@/lib/research-client";
import { friendlyError } from "@/lib/errors";
import type { PersonToMeet } from "@/lib/people-to-meet";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const PREVIEW_COUNT = 4;

/** Shared by the preview list and its collapsed overflow so both lay out alike. */
const LIST_CLASS =
  "space-y-2 @3xl:grid @3xl:grid-cols-2 @3xl:gap-2 @3xl:space-y-0";

export type SuggestedOutreachItem = {
  id: string;
  suggestionType: string;
  description: string | null;
  contactId: string | null;
  contactName: string;
  contactTitle?: string | null;
  contactCompany?: string | null;
  lastInteractionAt?: Date | string | null;
  tier?: "inner" | "mid" | "outer";
};

/** Loads after paint (a weekly web search can be slow) and renders nothing until there are rows. */
function PeopleToMeet() {
  const [result, setResult] = useState<{ people: PersonToMeet[]; canResearch: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    getPeopleToMeet()
      .then((r) => live && setResult(r))
      .catch(() => {}); // a failed load is the same as nothing to show
    return () => {
      live = false;
    };
  }, []);
  if (!result?.people.length) return null;
  return (
    <section aria-labelledby="people-to-meet" className="space-y-2 pt-2">
      <h3 id="people-to-meet" className="text-sm font-medium text-ink">People to meet</h3>
      <div className={LIST_CLASS}>
        {result.people.map((p) => (
          <PersonToMeetRow key={p.url} person={p} canResearch={result.canResearch} />
        ))}
      </div>
    </section>
  );
}

function PersonToMeetRow({ person, canResearch }: { person: PersonToMeet; canResearch: boolean }) {
  const [briefKey, setBriefKey] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Save and Brief share one person brief (cached server-side), so Save never needs Brief first.
  const brief = async () => {
    if (briefKey) return briefKey;
    const url = person.url.replace(/[?#].*$/, "");
    const [, company = ""] = (person.headline ?? "").split(" at ");
    const b = await requestBrief({
      kind: "person",
      fullName: person.name,
      company,
      linkedinUrl: LINKEDIN_PROFILE.test(url) ? url : "",
    });
    setBriefKey(b.key);
    if (b.dossier.kind === "person" && b.dossier.match === "confident") setSummary(b.dossier.summary ?? null);
    return b.key;
  };
  const run = (then: (key: string) => Promise<void>) =>
    start(async () => {
      try {
        await then(await brief());
      } catch (err) {
        toast.error(friendlyError(err, "That didn’t work — try again?"));
      }
    });
  const save = () =>
    run(async (key) => {
      const res = await saveResearchedPerson(key);
      if (!res.ok) return void toast.error(res.error);
      setSaved(res.value.contactId);
    });

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <a
        href={person.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary hover:underline"
      >
        {person.name}
      </a>
      {person.headline && <p className="mt-0.5 text-xs text-muted-foreground">{person.headline}</p>}
      <p className="mt-1.5 text-sm text-ink/80">{person.whyMatches}</p>
      {summary && <p className="mt-1.5 text-xs text-muted-foreground">{summary}</p>}
      {canResearch && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {saved ? (
            <Link href={`/contacts/${saved}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
              Saved — open
            </Link>
          ) : (
            <>
              <Button type="button" size="sm" disabled={pending} onClick={save}>
                Save
              </Button>
              {!summary && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(async () => {})}
                >
                  {pending ? "Reading…" : "Brief"}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SuggestedOutreachCard({
  items,
  networkIsEmpty,
  dueFollowUpCount,
  replyRate,
}: {
  /** The account's reply rate, drawn beside the heading. */
  replyRate?: React.ReactNode;
  items: SuggestedOutreachItem[];
  /** No contacts at all — the only case where "add contacts" is the right advice. */
  networkIsEmpty: boolean;
  /** Suggestions for people already listed as due are filtered out; say where they went. */
  dueFollowUpCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PREVIEW_COUNT;
  const preview = items.slice(0, PREVIEW_COUNT);
  const overflow = items.slice(PREVIEW_COUNT);
  const hiddenCount = items.length - PREVIEW_COUNT;

  return (
    <Card className="flex h-full flex-col border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CardTitle as="h2" className="text-base">Suggested outreach</CardTitle>
          {replyRate}
        </div>
        <Link
          href="/capture"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          Capture <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent
        id="suggestions"
        // @container so the list below can respond to THIS CARD's width rather than
        // the viewport's. The card is half-width when Outreach performance is
        // showing and full-width when it isn't (that card removes itself for any
        // account that has never run a campaign — most of them), and a viewport
        // breakpoint cannot tell those apart.
        className="@container flex flex-1 flex-col space-y-2 scroll-mt-8"
      >
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            {/* "Add contacts or log interactions" was shown to accounts with 24 contacts
                and six overdue follow-ups, because anyone already listed as due is
                filtered out of this queue. Say what is actually true instead. */}
            {networkIsEmpty
              ? "No one to reach out to yet — add a contact or import your network."
              : dueFollowUpCount > 0
                ? `Nothing extra to suggest — your ${dueFollowUpCount} due follow-up${
                    dueFollowUpCount === 1 ? "" : "s"
                  } are the priority right now.`
                : "Nobody has gone quiet. Log an interaction and Orbit will keep watching."}
          </p>
        ) : (
          <>
            {/* Two-up once the card itself is past ~768px. Stretched to a full
                row, a suggestion put its name a thousand pixels from its own
                dismiss button with nothing in between. */}
            <div className={LIST_CLASS}>
              {preview.map((s) => (
                <SuggestionRow
                  key={s.id}
                  id={s.id}
                  suggestionType={s.suggestionType}
                  description={s.description}
                  contactId={s.contactId}
                  contactName={s.contactName}
                  contactTitle={s.contactTitle}
                  contactCompany={s.contactCompany}
                  lastInteractionAt={s.lastInteractionAt}
                  tier={s.tier}
                />
              ))}
            </div>
            {hasMore ? (
              <>
                {/* The overflow stays mounted and collapses to zero height, so
                    growing the list is a transition rather than a jump. 0fr->1fr
                    on a grid row is the repo's own height-collapse technique
                    (contacts-list.tsx:434) — it animates to the content's real
                    height without measuring it. `inert` keeps the collapsed rows
                    out of the tab order and the accessibility tree; without it
                    they stay reachable while invisible. */}
                <div
                  id="suggestions-overflow"
                  inert={!expanded}
                  className={cn(
                    "grid transition-[grid-template-rows,opacity] duration-slow ease-house",
                    expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  )}
                >
                  <div className="overflow-hidden">
                    <div className={cn(LIST_CLASS, "pt-2")}>
                      {overflow.map((s) => (
                        <SuggestionRow
                          key={s.id}
                          id={s.id}
                          suggestionType={s.suggestionType}
                          description={s.description}
                          contactId={s.contactId}
                          contactName={s.contactName}
                          contactTitle={s.contactTitle}
                          contactCompany={s.contactCompany}
                  lastInteractionAt={s.lastInteractionAt}
                          tier={s.tier}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-auto pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full text-muted-foreground"
                    aria-expanded={expanded}
                    aria-controls="suggestions-overflow"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded
                      ? "See less"
                      : `See more${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
        <PeopleToMeet />
      </CardContent>
    </Card>
  );
}
