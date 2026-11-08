"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  Briefcase,
  Building2,
  Check,
  Compass,
  ExternalLink,
  Filter,
  Loader2,
  Plus,
  Search,
  Sparkles,
  UserPlus,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/lib/toast";
import {
  searchPeopleWithBrightDataAction,
  getOutreachFlowSuggestionsAction,
  addBrightDataCandidatesToCampaignAction,
} from "@/actions/outreach";
import { createContact } from "@/actions/contacts";
import type { BrightDataCandidate, PeopleSearchCriteria } from "@/lib/brightdata";
import type { OutreachSuggestion } from "@/lib/outreach-suggestions";
import { BrightDataIntegrationGuide } from "@/components/outreach/brightdata-integration-guide";
import { cn } from "@/lib/utils";

type SearchMode = "description" | "company" | "fields";

const SEARCH_MODES = [
  { id: "description" as const, label: "Person", icon: Sparkles },
  { id: "company" as const, label: "Company", icon: Building2 },
  { id: "fields" as const, label: "Role & Location", icon: Filter },
];

const STARTER_PERSON_SUGGESTIONS = [
  "Software Engineers and Tech Leads at Google or Meta",
  "Investment Banking Analysts at Goldman Sachs or Morgan Stanley",
  "Management Consultants at McKinsey, BCG, or Bain",
  "University Campus Recruiters for summer internships",
  "Associate Product Managers (APM) and PMs at Stripe",
];

const STARTER_COMPANY_SUGGESTIONS = [
  "Google",
  "Goldman Sachs",
  "McKinsey & Company",
  "Stripe",
  "Morgan Stanley",
  "Microsoft",
];

const STARTER_ROLE_SUGGESTIONS = [
  "Software Engineer",
  "Investment Banking Analyst",
  "Management Consultant",
  "Product Manager",
  "University Recruiter",
  "Data Scientist",
];

export function FindProspectsSearch({
  campaigns = [],
  isBrightDataLive = false,
  onProspectsAdded,
}: {
  campaigns?: Array<{ id: string; name: string }>;
  isBrightDataLive?: boolean;
  onProspectsAdded?: () => void;
  className?: string;
}) {
  const [mode, setMode] = useState<SearchMode>("description");
  const [pending, start] = useTransition();

  // Search Criteria States
  const [descriptionQuery, setDescriptionQuery] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyRole, setCompanyRole] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [seniorityInput, setSeniorityInput] = useState("All Seniorities");
  const [locationInput, setLocationInput] = useState("");
  const [industryInput, setIndustryInput] = useState("All Industries");

  // Results & Flow Suggestions
  const [candidates, setCandidates] = useState<BrightDataCandidate[]>([]);
  const [suggestions, setSuggestions] = useState<OutreachSuggestion[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>(
    campaigns[0]?.id || ""
  );
  const [hasSearched, setHasSearched] = useState(false);
  const [savingContactId, setSavingContactId] = useState<string | null>(null);

  // Load flow suggestions on mount
  useEffect(() => {
    getOutreachFlowSuggestionsAction()
      .then((sugs) => setSuggestions(sugs))
      .catch(() => {});
  }, []);

  function executeSearch(criteria: PeopleSearchCriteria) {
    setHasSearched(true);
    start(async () => {
      try {
        const res = await searchPeopleWithBrightDataAction(criteria);
        setCandidates(res.candidates);
        setSelectedCandidates(new Set(res.candidates.map((c) => c.id)));
        if (res.candidates.length > 0) {
          toast.success(`Found ${res.candidates.length} matching people`);
        } else {
          toast.message("No matching people found. Try adjusting your query.");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Search failed to complete");
      }
    });
  }

  function handleDescriptionSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!descriptionQuery.trim()) return;
    executeSearch({ query: descriptionQuery.trim(), limit: 8 });
  }

  function handleCompanySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!companyName.trim()) return;
    executeSearch({
      company: companyName.trim(),
      titles: companyRole.trim() ? [companyRole.trim()] : undefined,
      limit: 8,
    });
  }

  function handleFieldsSubmit(e: React.FormEvent) {
    e.preventDefault();
    const titles = titleInput.split(",").map((t) => t.trim()).filter(Boolean);
    const locations = locationInput ? [locationInput.trim()] : undefined;

    executeSearch({
      titles: titles.length ? titles : undefined,
      seniorities: seniorityInput !== "All Seniorities" ? [seniorityInput] : undefined,
      industries: industryInput !== "All Industries" ? [industryInput] : undefined,
      locations,
      limit: 8,
    });
  }

  function applySuggestion(suggestion: OutreachSuggestion) {
    if (suggestion.criteria.company) {
      setMode("company");
      setCompanyName(suggestion.criteria.company);
      setCompanyRole(suggestion.criteria.titles?.[0] || "");
    } else if (suggestion.query) {
      setMode("description");
      setDescriptionQuery(suggestion.query);
    }
    executeSearch({
      ...suggestion.criteria,
      query: suggestion.query,
      limit: 8,
    });
  }

  function toggleCandidateSelection(id: string) {
    setSelectedCandidates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selectedCandidates.size === candidates.length) {
      setSelectedCandidates(new Set());
    } else {
      setSelectedCandidates(new Set(candidates.map((c) => c.id)));
    }
  }

  async function handleAddSelectedToCampaign() {
    if (!selectedCampaignId) {
      toast.error("Please select a campaign first");
      return;
    }
    const toAdd = candidates.filter((c) => selectedCandidates.has(c.id));
    if (!toAdd.length) {
      toast.error("Select at least one person to add");
      return;
    }

    start(async () => {
      try {
        const res = await addBrightDataCandidatesToCampaignAction({
          campaignId: selectedCampaignId,
          candidates: toAdd,
        });
        toast.success(`Added ${res.added} prospects to campaign with drafts generated!`);
        setSelectedCandidates(new Set());
        onProspectsAdded?.();
      } catch (err) {
        toast.error("Failed to add prospects to campaign");
      }
    });
  }

  async function handleSaveContact(candidate: BrightDataCandidate) {
    setSavingContactId(candidate.id);
    try {
      await createContact({
        fullName: candidate.fullName,
        company: candidate.company,
        title: candidate.title,
        location: candidate.location,
        linkedinUrl: candidate.linkedinUrl,
      });
      toast.success(`Saved ${candidate.fullName} to your contacts`);
    } catch {
      toast.error("Failed to save contact");
    } finally {
      setSavingContactId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Search Container Card */}
      <div className="rounded-2xl border border-border/70 bg-card p-5 space-y-4">
        {/* Top bar: Mode switcher & Scraper status */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-border/70 bg-muted/40 p-1 text-xs">
            {SEARCH_MODES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors",
                  mode === id
                    ? "bg-card text-ink shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <BrightDataIntegrationGuide isConfigured={isBrightDataLive} />
        </div>

        {/* Mode 1: Person (AI Description) */}
        {mode === "description" && (
          <form onSubmit={handleDescriptionSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground block">
                Describe the person or role you want to find
              </Label>
              <div className="flex gap-2.5">
                <div className="relative flex-1">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    value={descriptionQuery}
                    onChange={(e) => setDescriptionQuery(e.target.value)}
                    placeholder="e.g. Founders of Series A AI startups in SF, or Stripe recruiters"
                    className="pl-10 h-10 text-sm rounded-xl bg-background"
                    disabled={pending}
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  disabled={pending || !descriptionQuery.trim()}
                  className="h-10 px-4 rounded-xl gap-1.5 shrink-0"
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Find People
                </Button>
              </div>
            </div>

            {/* Suggestions row with equal spacing */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-ink/70">
                <Sparkles className="h-3 w-3 text-primary" />
                Try:
              </span>
              {(suggestions.length > 0 ? suggestions.slice(0, 4) : STARTER_PERSON_SUGGESTIONS).map((sug, i) => {
                const label = typeof sug === "string" ? sug : sug.label;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      if (typeof sug === "string") {
                        setDescriptionQuery(sug);
                        executeSearch({ query: sug, limit: 8 });
                      } else {
                        applySuggestion(sug);
                      }
                    }}
                    disabled={pending}
                    className="rounded-lg border border-border/70 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-ink active:scale-[0.98] transition"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </form>
        )}

        {/* Mode 2: By Company */}
        {mode === "company" && (
          <form onSubmit={handleCompanySubmit} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
              <div className="sm:col-span-6 space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground block">
                  Company Name
                </Label>
                <Input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="e.g. Linear, Supabase, Stripe"
                  className="h-10 text-sm rounded-xl bg-background"
                  disabled={pending}
                  autoFocus
                />
              </div>
              <div className="sm:col-span-4 space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground block">
                  Target Role (optional)
                </Label>
                <Input
                  value={companyRole}
                  onChange={(e) => setCompanyRole(e.target.value)}
                  placeholder="e.g. Engineering, Recruiting, Founder"
                  className="h-10 text-sm rounded-xl bg-background"
                  disabled={pending}
                />
              </div>
              <div className="sm:col-span-2">
                <Button
                  type="submit"
                  disabled={pending || !companyName.trim()}
                  className="h-10 w-full rounded-xl gap-1.5"
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Building2 className="h-4 w-4" />
                  )}
                  Search
                </Button>
              </div>
            </div>

            {/* Suggestions row with equal spacing */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-ink/70">
                <Building2 className="h-3 w-3 text-primary" />
                Try companies:
              </span>
              {STARTER_COMPANY_SUGGESTIONS.map((comp) => (
                <button
                  key={comp}
                  type="button"
                  onClick={() => {
                    setCompanyName(comp);
                    executeSearch({ company: comp, limit: 8 });
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border/70 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-ink active:scale-[0.98] transition"
                >
                  {comp}
                </button>
              ))}
            </div>
          </form>
        )}

        {/* Mode 3: By Role & Location */}
        {mode === "fields" && (
          <form onSubmit={handleFieldsSubmit} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground block">
                  Job Title
                </Label>
                <Input
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  placeholder="e.g. VP Engineering, CTO"
                  className="h-10 text-sm rounded-xl bg-background"
                  disabled={pending}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground block">
                  Seniority
                </Label>
                <select
                  value={seniorityInput}
                  onChange={(e) => setSeniorityInput(e.target.value)}
                  disabled={pending}
                  className="w-full rounded-xl border border-input bg-background px-3 text-sm shadow-xs h-10"
                >
                  {["All Seniorities", "Executive / C-Level", "VP", "Director", "Senior / Lead", "Founder"].map(
                    (s) => (
                      <option key={s} value={s}>{s}</option>
                    )
                  )}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground block">
                  Industry
                </Label>
                <select
                  value={industryInput}
                  onChange={(e) => setIndustryInput(e.target.value)}
                  disabled={pending}
                  className="w-full rounded-xl border border-input bg-background px-3 text-sm shadow-xs h-10"
                >
                  {["All Industries", "Artificial Intelligence", "B2B SaaS", "Developer Tools", "Fintech", "Healthtech"].map(
                    (i) => (
                      <option key={i} value={i}>{i}</option>
                    )
                  )}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground block">
                  Location
                </Label>
                <Input
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                  placeholder="e.g. San Francisco, NY"
                  className="h-10 text-sm rounded-xl bg-background"
                  disabled={pending}
                />
              </div>
            </div>

            {/* Suggestions & Submit Row with equal spacing */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-medium text-ink/70">
                  <Filter className="h-3 w-3 text-primary" />
                  Try roles:
                </span>
                {STARTER_ROLE_SUGGESTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setTitleInput(r);
                      executeSearch({ titles: [r], limit: 8 });
                    }}
                    disabled={pending}
                    className="rounded-lg border border-border/70 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-ink active:scale-[0.98] transition"
                  >
                    {r}
                  </button>
                ))}
              </div>

              <Button
                type="submit"
                disabled={pending}
                className="h-10 px-4 rounded-xl gap-1.5"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Filter className="h-4 w-4" />
                )}
                Filter Search
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Loading Skeleton */}
      {pending && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>Searching web & LinkedIn profiles via BrightData...</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="animate-pulse rounded-2xl border border-border/60 bg-card p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="h-11 w-11 rounded-full bg-muted" />
                  <div className="space-y-1.5 flex-1">
                    <div className="h-4 w-1/2 rounded bg-muted" />
                    <div className="h-3 w-3/4 rounded bg-muted/60" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="h-3 w-full rounded bg-muted/40" />
                  <div className="h-3 w-4/5 rounded bg-muted/40" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Initial Empty State (before any search has run) */}
      {!hasSearched && !pending && (
        <div className="rounded-2xl border border-dashed border-border/70 p-10 text-center bg-card/30">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Compass className="h-5 w-5" />
          </div>
          <h3 className="font-semibold text-ink text-base">Search Anyone Outside Your Network</h3>
          <p className="mt-1 text-sm text-muted-foreground max-w-sm mx-auto">
            Find people by role, company, or what they do. We pull verified profile pictures, current titles, and recent company news.
          </p>
        </div>
      )}

      {/* Results Section */}
      {!pending && candidates.length > 0 && (
        <div className="space-y-4 pt-1">
          {/* Action & Selection Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-4 py-2.5">
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={selectAll}
                className="font-medium text-ink hover:underline"
              >
                {selectedCandidates.size === candidates.length ? "Deselect All" : "Select All"} ({candidates.length})
              </button>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                <strong className="text-ink">{selectedCandidates.size}</strong> selected
              </span>
            </div>

            <div className="flex items-center gap-2">
              {campaigns.length > 0 ? (
                <>
                  <select
                    value={selectedCampaignId}
                    onChange={(e) => setSelectedCampaignId(e.target.value)}
                    className="rounded-lg border border-input bg-background px-2.5 py-1 text-xs h-8"
                  >
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        Add to: {c.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={selectedCandidates.size === 0}
                    onClick={handleAddSelectedToCampaign}
                    className="text-xs gap-1.5 h-8 px-3"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add to Campaign
                  </Button>
                </>
              ) : (
                <Link
                  href="/outreach/new"
                  className={cn(buttonVariants({ size: "sm" }), "text-xs gap-1.5 h-8 px-3")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Campaign
                </Link>
              )}
            </div>
          </div>

          {/* Candidates Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {candidates.map((candidate) => {
              const isSelected = selectedCandidates.has(candidate.id);
              const isSaving = savingContactId === candidate.id;

              return (
                <div
                  key={candidate.id}
                  onClick={() => toggleCandidateSelection(candidate.id)}
                  className={cn(
                    "rounded-2xl border p-4 transition-all cursor-pointer flex flex-col justify-between gap-3 text-left",
                    isSelected
                      ? "border-primary bg-primary/[0.02] ring-1 ring-primary shadow-xs"
                      : "border-border/70 bg-card hover:border-border hover:shadow-xs"
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Profile Picture / Initials */}
                    <div className="relative h-11 w-11 shrink-0 rounded-full overflow-hidden border border-border/70 bg-muted">
                      {candidate.avatarUrl ? (
                        <img
                          src={candidate.avatarUrl}
                          alt={candidate.fullName}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center font-medium text-xs text-muted-foreground">
                          {candidate.fullName.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="font-semibold text-ink text-sm truncate">
                          {candidate.fullName}
                        </h4>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          aria-label={`Select ${candidate.fullName}`}
                          className="rounded border-border text-primary focus:ring-primary h-4 w-4 shrink-0"
                        />
                      </div>
                      <p className="text-xs text-ink/80 truncate mt-0.5">
                        {candidate.title} <span className="text-muted-foreground">at</span>{" "}
                        <span className="font-medium text-ink">{candidate.company}</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {candidate.location}
                      </p>
                    </div>
                  </div>

                  {/* Summary & News context */}
                  <div className="space-y-2 text-xs">
                    <p className="text-muted-foreground line-clamp-2 leading-relaxed text-[12px]">
                      {candidate.summary}
                    </p>

                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary">
                        {candidate.matchReason}
                      </span>
                      {candidate.recentNews && (
                        <span className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 truncate max-w-full">
                          {candidate.recentNews}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Footer actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-border/50 text-xs">
                    {candidate.linkedinUrl ? (
                      <a
                        href={candidate.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-primary hover:underline text-[11px]"
                      >
                        LinkedIn Profile <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-[11px]">Public web profile</span>
                    )}

                    <div onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isSaving}
                        onClick={() => handleSaveContact(candidate)}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-ink gap-1"
                      >
                        {isSaving ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <UserPlus className="h-3 w-3" />
                        )}
                        Save Contact
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
