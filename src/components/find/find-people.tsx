"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Building2, Check, ExternalLink, Loader2, RefreshCw, Search, UserPlus, UserSearch } from "lucide-react";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { PageSection } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl, SegmentedPanel } from "@/components/ui/segmented-control";
import { useViewerPlan } from "@/components/viewer-plan";
import { saveResearchedPerson } from "@/actions/web-research";
import { friendlyError, UserFacingError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import type { Candidate, CompanyDossier, DiscoveryResult, PersonDossier, ResearchBrief } from "@/lib/web-research";

type Brief = { key: string; dossier: ResearchBrief };
type PersonBrief = { key: string; dossier: PersonDossier };
type CompanyBrief = { key: string; dossier: CompanyDossier };
type DiscoveryBrief = { key: string; dossier: DiscoveryResult };
type Mode = "person" | "company" | "discover";

const MODE_ITEMS = [
  { key: "person" as const, label: "A person", icon: <UserSearch aria-hidden /> },
  { key: "company" as const, label: "A company", icon: <Building2 aria-hidden /> },
  { key: "discover" as const, label: "By description", icon: <Search aria-hidden /> },
];

/** A LinkedIn profile page is the strongest anchor a brief can get. The server re-checks it. */
const LINKEDIN_PROFILE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#\s]+\/?$/i;

/** POSTs to `/api/research` (a route, for its longer time limit than a server action's). */
async function requestBrief(body: Record<string, unknown>): Promise<Brief> {
  const res = await fetch("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json", "x-orbit-research": "1" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (Brief & { error?: string }) | null;
  // The route's messages are written for the person (no anchor, today's limit, no AI key);
  // a plain Error would be swapped for the generic fallback by `friendlyError`.
  if (!res.ok || !data?.dossier) {
    if (data?.error) throw new UserFacingError(data.error);
    throw new Error("The search didn’t finish — try again in a moment");
  }
  return { key: data.key, dossier: data.dossier };
}

export function FindPeople({ canUseAi, recent }: { canUseAi: boolean; recent: Brief[] }) {
  const { aiReason } = useViewerPlan();
  const [mode, setMode] = useState<Mode>("person");
  const [fullName, setFullName] = useState("");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [query, setQuery] = useState("");
  const [brief, setBrief] = useState<Brief | null>(null);
  const [history, setHistory] = useState(recent);
  const [pending, start] = useTransition();

  const run = (body: Record<string, unknown>) =>
    start(async () => {
      try {
        const next = await requestBrief(body);
        setBrief(next);
        setHistory((h) => [next, ...h.filter((b) => b.key !== next.key)].slice(0, 10));
      } catch (err) {
        toast.error(friendlyError(err, "The search didn’t finish — try again in a moment"));
      }
    });

  /** A person from a company brief: the company is the anchor that makes them findable. */
  const briefPerson = (person: { fullName: string }, from: CompanyDossier) => {
    const typedDomain = from.subject.domain ?? (from.website ? new URL(from.website).hostname.replace(/^www\./, "") : "");
    setMode("person");
    setFullName(person.fullName);
    setCompany(from.subject.name);
    setDomain(typedDomain);
    setLinkedinUrl("");
    run({ kind: "person", fullName: person.fullName, company: from.subject.name, domain: typedDomain });
  };

  /** A discovered candidate: their company, and their LinkedIn page when that is what found them. */
  const briefCandidate = (c: Candidate) => {
    const linkedin = LINKEDIN_PROFILE.test(c.url.replace(/[?#].*$/, "")) ? c.url.replace(/[?#].*$/, "") : "";
    setMode("person");
    setFullName(c.fullName);
    setCompany(c.company ?? "");
    setDomain("");
    setLinkedinUrl(linkedin);
    run({ kind: "person", fullName: c.fullName, company: c.company ?? "", linkedinUrl: linkedin });
  };

  const submitLabel = pending ? "Searching the web…" : mode === "discover" ? "Find people" : "Research";
  const typed = mode === "person" ? fullName : mode === "company" ? company : query;
  const canSubmit = canUseAi && !pending && typed.trim();

  return (
    <div className="space-y-5">
      {/* Research runs a web search on the person's AI provider, so without AI it cannot run. */}
      {!canUseAi && <AiKeyNotice feature="find" reason={aiReason ?? "key_required"} compact />}

      <SegmentedControl
        id="find-mode"
        items={MODE_ITEMS}
        value={mode}
        onChange={setMode}
        ariaLabel="What to research"
      />

      {/* One form serves every mode, so it is the panel for whichever tab is selected. */}
      <SegmentedPanel id="find-mode" value={mode} active={mode}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(
            mode === "person"
              ? { kind: "person", fullName, company, domain, linkedinUrl }
              : mode === "company"
                ? { kind: "company", name: company, domain }
                : { kind: "discover", query }
          );
        }}
        className="grid gap-4 rounded-xl border border-border-subtle bg-card p-4 sm:grid-cols-2"
      >
        {mode === "person" && (
          <FormField label="Name" id="find-name" className="sm:col-span-2">
            <Input id="find-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Doe" autoComplete="off" maxLength={100} />
          </FormField>
        )}
        {mode === "discover" && (
          <FormField label="Who are you looking for?" id="find-query" className="sm:col-span-2">
            <Input
              id="find-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Product managers at Stripe who went to Michigan"
              autoComplete="off"
              maxLength={300}
            />
          </FormField>
        )}
        {mode !== "discover" && (
          <>
            <FormField label="Company" id="find-company">
              <Input id="find-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Stripe" autoComplete="off" maxLength={100} />
            </FormField>
            <FormField label="Company website" id="find-domain">
              <Input id="find-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="stripe.com" autoComplete="off" maxLength={253} />
            </FormField>
          </>
        )}
        {mode === "person" && (
          <FormField label="LinkedIn profile" id="find-linkedin" className="sm:col-span-2">
            <Input id="find-linkedin" value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} placeholder="linkedin.com/in/…" autoComplete="off" maxLength={300} />
          </FormField>
        )}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={!canSubmit}>
            {pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <UserSearch className="size-4" aria-hidden />}
            {submitLabel}
          </Button>
          <p className="text-xs text-muted-foreground">
            {mode === "person"
              ? "Add a company, website or LinkedIn link — a name alone matches too many people. Only what you type here is searched."
              : mode === "company"
                ? "The website keeps namesakes out. Only what you type here is searched."
                : "Role, company, school, place — whatever matters. You’ll get a handful of people found on the web, not a complete list."}
          </p>
        </div>
      </form>
      </SegmentedPanel>

      <div aria-live="polite">
        {brief?.dossier.kind === "person" && (
          <DossierCard
            key={brief.key}
            brief={brief as PersonBrief}
            refreshing={pending}
            onRefresh={() => run({ kind: "person", ...(brief.dossier as PersonDossier).subject, fresh: true })}
          />
        )}
        {brief?.dossier.kind === "company" && (
          <CompanyCard
            key={brief.key}
            brief={brief as CompanyBrief}
            refreshing={pending}
            onRefresh={() => run({ kind: "company", ...(brief.dossier as CompanyDossier).subject, fresh: true })}
            onBriefPerson={briefPerson}
          />
        )}
        {brief?.dossier.kind === "discover" && (
          <DiscoveryCard
            key={brief.key}
            brief={brief as DiscoveryBrief}
            refreshing={pending}
            onRefresh={() => run({ kind: "discover", query: (brief.dossier as DiscoveryResult).query, fresh: true })}
            onBrief={briefCandidate}
          />
        )}
      </div>

      {history.length > 0 && (
        <PageSection title="Recent" description="Briefs are kept for 14 days, then deleted.">
          <ul className="flex flex-wrap gap-2">
            {history.map((b) => (
              <li key={b.key}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full font-normal"
                  onClick={() => {
                    setBrief(b);
                    setMode(b.dossier.kind);
                  }}
                >
                  {b.dossier.kind === "discover" ? (
                    <>
                      <Search className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="max-w-56 truncate">{b.dossier.query}</span>
                    </>
                  ) : b.dossier.kind === "company" ? (
                    <>
                      <Building2 className="size-3.5 text-muted-foreground" aria-hidden />
                      {b.dossier.subject.name}
                    </>
                  ) : (
                    <>
                      {b.dossier.subject.fullName}
                      {b.dossier.subject.company ? <span className="text-muted-foreground"> · {b.dossier.subject.company}</span> : null}
                    </>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </PageSection>
      )}
    </div>
  );
}

function yearRange(e: PersonDossier["experiences"][number]): string {
  const end = e.isCurrent ? "now" : e.endYear ?? "";
  return e.startYear ? `${e.startYear}–${end}` : e.isCurrent ? "Current" : "";
}

function DossierCard({ brief, refreshing, onRefresh }: { brief: PersonBrief; refreshing: boolean; onRefresh: () => void }) {
  const { dossier } = brief;
  const [saved, setSaved] = useState<{ contactId: string; existing: boolean } | null>(null);
  const [saving, startSave] = useTransition();
  const subtitle = dossier.current
    ? [dossier.current.title, dossier.current.organization].filter(Boolean).join(" · ")
    : dossier.subject.company;

  const save = () =>
    startSave(async () => {
      try {
        const res = await saveResearchedPerson(brief.key);
        if (!res.ok) return void toast.error(res.error);
        setSaved({ contactId: res.value.contactId, existing: res.value.outcome !== "created" });
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save them — try again?"));
      }
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex flex-wrap items-center gap-2 text-lg">
          <span className="truncate">{dossier.subject.fullName}</span>
          {dossier.match !== "confident" && (
            <Badge variant="outline" tone="neutral">{dossier.match === "unsure" ? "Couldn’t confirm it’s them" : "Nothing found"}</Badge>
          )}
        </CardTitle>
        {(subtitle || dossier.location) && (
          <CardDescription>
            {subtitle}
            {subtitle && dossier.location ? " · " : ""}
            {dossier.location}
          </CardDescription>
        )}
        <CardAction className="flex gap-2">
          <SearchAgainButton refreshing={refreshing} onRefresh={onRefresh} />
          {saved ? (
            <Link href={`/contacts/${saved.contactId}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline">
              <Check className="size-4" aria-hidden />
              {saved.existing ? "Already in Orbit" : "Saved"}
            </Link>
          ) : (
            <Button size="sm" disabled={saving} onClick={save}>
              {saving ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
              {saving ? "Saving…" : "Save to Orbit"}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">

      {dossier.match === "unsure" && (
        <p className="text-sm text-muted-foreground">
          The pages found might be about someone else with this name, so nothing is shown as fact. Add their LinkedIn link or company website and search again, or check the sources below.
        </p>
      )}
      {dossier.match === "none" && (
        <p className="text-sm text-muted-foreground">No public pages about them turned up. Try their LinkedIn link or company website.</p>
      )}

      {dossier.summary && <p className="text-sm leading-relaxed text-ink">{dossier.summary}</p>}

      {dossier.talkingPoints.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-medium text-ink">Worth bringing up</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {dossier.talkingPoints.map((p) => (
              <li key={p.text}>
                {p.text}
                {p.url && (
                  <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="ml-1 inline-flex align-middle text-muted-foreground hover:text-ink" aria-label="Source">
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dossier.experiences.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-medium text-ink">Experience</h3>
          <ul className="space-y-1 text-sm">
            {dossier.experiences.map((e, i) => (
              <li key={`${e.organization}-${i}`} className="flex gap-2">
                <span className="min-w-0 flex-1 text-ink">{[e.title, e.organization].filter(Boolean).join(" · ")}</span>
                <span className="shrink-0 text-muted-foreground">{yearRange(e)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Sources sources={dossier.sources} />
      </CardContent>
    </Card>
  );
}

/** The same "search again" control on every brief: an icon with its label, never a spinner alone. */
function SearchAgainButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
      <RefreshCw className={refreshing ? "size-4 motion-safe:animate-spin" : "size-4"} aria-hidden />
      {refreshing ? "Searching…" : "Search again"}
    </Button>
  );
}

function Sources({ sources }: { sources: ResearchBrief["sources"] }) {
  if (!sources.length) return null;
  return (
    <section>
      <h3 className="mb-1.5 text-sm font-medium text-ink">Sources</h3>
      <ul className="space-y-1 text-sm">
        {sources.map((s) => (
          <li key={s.url} className="truncate">
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline-offset-4 hover:underline">
              {s.title || new URL(s.url).hostname}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">Found on the public web — check before you rely on it.</p>
    </section>
  );
}

function CompanyCard({
  brief,
  refreshing,
  onRefresh,
  onBriefPerson,
}: {
  brief: CompanyBrief;
  refreshing: boolean;
  onRefresh: () => void;
  onBriefPerson: (person: { fullName: string }, from: CompanyDossier) => void;
}) {
  const { dossier } = brief;
  const facts = [dossier.headquarters, dossier.founded && `Founded ${dossier.founded}`, dossier.size].filter(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex flex-wrap items-center gap-2 text-lg">
          <span className="truncate">{dossier.subject.name}</span>
          {dossier.match !== "confident" && (
            <Badge variant="outline" tone="neutral">{dossier.match === "unsure" ? "Couldn’t confirm it’s them" : "Nothing found"}</Badge>
          )}
        </CardTitle>
        {(dossier.website || facts.length > 0) && (
          <CardDescription>
            {dossier.website && (
              <a href={dossier.website} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-ink">
                {new URL(dossier.website).hostname.replace(/^www\./, "")}
              </a>
            )}
            {dossier.website && facts.length > 0 ? " · " : ""}
            {facts.join(" · ")}
          </CardDescription>
        )}
        <CardAction>
          <SearchAgainButton refreshing={refreshing} onRefresh={onRefresh} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">

      {dossier.match === "unsure" && (
        <p className="text-sm text-muted-foreground">
          The pages found might be about a different company with this name. Add their website and search again, or check the sources below.
        </p>
      )}
      {dossier.match === "none" && <p className="text-sm text-muted-foreground">No public pages about them turned up. Try adding their website.</p>}

      {dossier.description && <p className="text-sm leading-relaxed text-ink">{dossier.description}</p>}

      {dossier.news.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-medium text-ink">Recent news</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {dossier.news.map((n) => (
              <li key={n.text}>
                {n.text}
                {n.url && (
                  <a href={n.url} target="_blank" rel="noopener noreferrer nofollow" className="ml-1 inline-flex align-middle text-muted-foreground hover:text-ink" aria-label="Source">
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dossier.people.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-medium text-ink">People worth talking to</h3>
          <ul className="divide-y divide-border-subtle">
            {dossier.people.map((p) => (
              <li key={p.url + p.fullName} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{p.fullName}</p>
                  {p.title && <p className="truncate text-xs text-muted-foreground">{p.title}</p>}
                </div>
                <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="shrink-0 text-muted-foreground hover:text-ink" aria-label={`Where ${p.fullName} was found`}>
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
                <Button variant="outline" size="sm" disabled={refreshing} onClick={() => onBriefPerson(p, dossier)}>
                  Brief
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Sources sources={dossier.sources} />
      </CardContent>
    </Card>
  );
}

function DiscoveryCard({
  brief,
  refreshing,
  onRefresh,
  onBrief,
}: {
  brief: DiscoveryBrief;
  refreshing: boolean;
  onRefresh: () => void;
  onBrief: (candidate: Candidate) => void;
}) {
  const { dossier } = brief;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-lg">{dossier.query}</CardTitle>
        <CardDescription>
          {dossier.candidates.length
            ? `${dossier.candidates.length} ${dossier.candidates.length === 1 ? "person" : "people"} found on the web — not a complete list.`
            : "Nobody clearly matching turned up. Try different wording, or name a company."}
        </CardDescription>
        <CardAction>
          <SearchAgainButton refreshing={refreshing} onRefresh={onRefresh} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
      {dossier.candidates.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {dossier.candidates.map((c) => (
            <li key={c.url + c.fullName} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{c.fullName}</p>
                {(c.title || c.company) && (
                  <p className="truncate text-xs text-muted-foreground">{[c.title, c.company].filter(Boolean).join(" · ")}</p>
                )}
                <p className="mt-0.5 text-xs text-ink/80">{c.whyMatches}</p>
              </div>
              <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-0.5 shrink-0 text-muted-foreground hover:text-ink" aria-label={`Where ${c.fullName} was found`}>
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => onBrief(c)}>
                Brief
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Sources sources={dossier.sources} />
      </CardContent>
    </Card>
  );
}
