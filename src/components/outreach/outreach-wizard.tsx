"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  createCampaign,
  generateOutreachDrafts,
  getCampaign,
  getOutreachApolloStatus,
  searchProspects,
  updateCampaign,
} from "@/actions/outreach";
import { AudienceFiltersEditor } from "@/components/outreach/audience-filters-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_SEQUENCE_STEPS,
  OUTREACH_CHANNELS,
  OUTREACH_REPLY_CTAS,
  OUTREACH_TONES,
  REPLY_CTA_LABELS,
  type AudienceFilters,
  type OutreachChannel,
  type OutreachReplyCta,
  type SequenceStep,
} from "@/lib/outreach-types";
import { friendlyError } from "@/lib/errors";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  GraduationCap,
  Search,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

const STEPS = ["Target Audience", "Prospect Discovery", "Message Strategy"] as const;

type ICPPreset = {
  id: string;
  badge: string;
  icon: typeof Sparkles;
  title: string;
  name: string;
  audience: string;
  intent: string;
  replyCta: OutreachReplyCta;
  tone: string;
  channel: OutreachChannel;
};

const ICP_PRESETS: ICPPreset[] = [
  {
    id: "investor",
    badge: "Fundraising",
    icon: Sparkles,
    title: "Angel & Seed Investors",
    name: "Angel & Seed Investor Outreach",
    audience: "Angel investors and seed-stage VC partners investing in AI, fintech, and developer tools",
    intent: "Introduce our product milestone and traction, and share a 2-minute deck intro",
    replyCta: "book_intro",
    tone: "founder",
    channel: "email",
  },
  {
    id: "sales",
    badge: "Enterprise",
    icon: TrendingUp,
    title: "Engineering Leaders",
    name: "VP Engineering & CTO Growth Campaign",
    audience: "VP of Engineering, CTO, and Head of Infrastructure at high-growth tech companies",
    intent: "Ask about their current engineering workflow bottlenecks and offer a 10-minute demo",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
  },
  {
    id: "recruiting",
    badge: "Talent",
    icon: Users,
    title: "Senior Engineers",
    name: "Senior Fullstack & AI Engineers",
    audience: "Staff and Senior Software Engineers specializing in React, Next.js, and TypeScript",
    intent: "Invite them for a casual coffee chat about our engineering roadmap and open founding roles",
    replyCta: "explore_partnership",
    tone: "warm",
    channel: "linkedin",
  },
  {
    id: "campus",
    badge: "Campus",
    icon: GraduationCap,
    title: "Tech Recruiters",
    name: "University Tech Recruiters Outreach",
    audience: "Technical University Recruiters and Campus Talent Leads at tier-1 tech companies",
    intent: "Inquire about upcoming software engineering internship opportunities and referral next steps",
    replyCta: "ask_referral",
    tone: "humble",
    channel: "email",
  },
];

type DiscoveredProspect = {
  id: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedinUrl: string | null;
  location: string | null;
  enrichment?: Record<string, unknown> | null;
};

export function OutreachWizard({ campaignId: initialCampaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState(initialCampaignId || "");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [audienceQuery, setAudienceQuery] = useState("");
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [hasApollo, setHasApollo] = useState<boolean | null>(null);
  const [messageIntent, setMessageIntent] = useState("");
  const [replyCta, setReplyCta] = useState<OutreachReplyCta>("book_intro");
  const [tone, setTone] = useState("professional");
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [templateSeed, setTemplateSeed] = useState("");
  const [enableSequence, setEnableSequence] = useState(true);
  const [sequenceSteps, setSequenceSteps] = useState<SequenceStep[]>(
    DEFAULT_SEQUENCE_STEPS
  );
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [lastSearchSource, setLastSearchSource] = useState<string | null>(null);
  const [discoveredProspects, setDiscoveredProspects] = useState<DiscoveredProspect[]>([]);
  const [pending, start] = useTransition();

  useEffect(() => {
    getOutreachApolloStatus()
      .then((s) => setHasApollo(s.hasApollo))
      .catch(() => setHasApollo(false));
  }, []);

  async function loadCampaignData(id: string) {
    try {
      const camp = await getCampaign(id);
      if (camp) {
        if (camp.prospects && camp.prospects.length > 0) {
          setDiscoveredProspects(camp.prospects as DiscoveredProspect[]);
          setSearchTotal(camp.prospects.length);
        }
        if (camp.lastSearchSource) {
          setLastSearchSource(camp.lastSearchSource);
        }
      }
    } catch {
      // Non-blocking load
    }
  }

  function applyPreset(preset: ICPPreset) {
    setSelectedPreset(preset.id);
    setName(preset.name);
    setAudienceQuery(preset.audience);
    setMessageIntent(preset.intent);
    setReplyCta(preset.replyCta);
    setTone(preset.tone);
    setChannel(preset.channel);
  }

  function goToCampaign(id: string) {
    router.push(`/outreach/${id}`);
    router.refresh();
  }

  function handleAudienceNext() {
    start(async () => {
      try {
        if (!campaignId) {
          const campaign = await createCampaign({
            name,
            audienceQuery,
            replyCta,
            sequenceSteps: enableSequence ? sequenceSteps : [],
          });
          setCampaignId(campaign.id);
          setFilters((campaign.audienceFilters as AudienceFilters) || {});
          await loadCampaignData(campaign.id);
          setStep(1);
          toast.success("Audience defined — review discovery criteria & search");
        } else {
          const updated = await updateCampaign(campaignId, {
            name,
            audienceQuery,
            replyCta,
            sequenceSteps: enableSequence ? sequenceSteps : [],
          });
          setFilters((updated.audienceFilters as AudienceFilters) || {});
          await loadCampaignData(campaignId);
          setStep(1);
        }
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save that audience — try again?"));
      }
    });
  }

  function handleSearch() {
    if (!campaignId) return;
    start(async () => {
      try {
        await updateCampaign(campaignId, {
          audienceFilters: filters,
          reparseAudience: false,
        });
        const res = await searchProspects(campaignId);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const result = res.value;
        setSearchTotal(result.total);
        setLastSearchSource(result.source);
        await loadCampaignData(campaignId);

        if (result.source === "demo") {
          toast.success(
            `Found ${result.matched} prospects` +
              (result.mismatched ? `, ${result.mismatched} excluded` : "")
          );
        } else {
          toast.success(
            `Discovered ${result.matched} matching prospects` +
              (result.mismatched ? ` (${result.mismatched} excluded)` : "")
          );
        }
      } catch (err) {
        toast.error(friendlyError(err, "Search failed — please try again"));
      }
    });
  }

  function handleMessageNext() {
    if (!campaignId) return;
    start(async () => {
      try {
        await updateCampaign(campaignId, {
          messageIntent,
          replyCta,
          tone,
          defaultChannel: channel,
          sequenceSteps: enableSequence ? sequenceSteps : [],
        });
        await generateOutreachDrafts({
          campaignId,
          channel,
          templateSeed: templateSeed || undefined,
          excludeLowSignal: true,
        });
        toast.success("Drafts ready — opening campaign workspace");
        goToCampaign(campaignId);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t write those drafts — try again?"));
      }
    });
  }

  const stepProgress = STEPS.map((_, i) => {
    if (i < step) return 1;
    if (i > step) return 0;
    if (i === 0) {
      const filled = (name.trim() ? 0.35 : 0) + (audienceQuery.trim() ? 0.65 : 0);
      return Math.min(1, Math.max(0.12, filled));
    }
    if (i === 1) {
      return discoveredProspects.length > 0 ? 1 : pending ? 0.6 : 0.2;
    }
    if (i === 2) {
      const filled =
        (messageIntent.trim() ? 0.55 : 0) +
        (tone ? 0.2 : 0) +
        (channel ? 0.15 : 0) +
        (templateSeed.trim() ? 0.1 : 0);
      return Math.min(1, Math.max(0.12, filled));
    }
    return 0.1;
  });

  return (
    <div className="space-y-6">
      {/* Progress tracker */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}
        role="list"
        aria-label="Campaign setup progress"
      >
        {STEPS.map((label, i) => {
          const value = stepProgress[i] ?? 0;
          const isCurrent = i === step;
          const isDone = i < step;
          return (
            <div key={label} role="listitem" className="min-w-0 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={`truncate text-xs font-semibold tracking-tight ${
                    isCurrent
                      ? "text-primary"
                      : isDone
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  Step {i + 1}: {label}
                </span>
                <span className="hidden shrink-0 text-3xs tabular-nums text-muted-foreground sm:inline">
                  {Math.round(value * 100)}%
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(value * 100)}
                aria-label={`${label} progress`}
              >
                <div
                  className={`h-full rounded-full transition-all duration-300 ease-out ${
                    isCurrent || isDone ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
                  style={{ width: `${Math.round(value * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Step 0: Target Audience & ICP */}
      {step === 0 && (
        <section className="space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
          {/* Quick Presets */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-ink uppercase tracking-wider">
                Quick ICP Presets
              </Label>
              <span className="text-xs text-muted-foreground">Pick a template or define your own</span>
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {ICP_PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = selectedPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`flex flex-col text-left rounded-xl border p-3.5 transition-all text-xs ${
                      isSelected
                        ? "border-primary bg-primary/5 ring-1 ring-primary shadow-xs"
                        : "border-border/60 bg-muted/20 hover:border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                        <Icon className="h-3 w-3" />
                        {preset.badge}
                      </span>
                      {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                    </div>
                    <span className="font-medium text-ink text-xs">{preset.title}</span>
                    <span className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                      {preset.audience}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name" className="text-xs font-medium text-ink">
                Campaign name
              </Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Series A Founders & Angel Outreach"
                className="h-10 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audience" className="text-xs font-medium text-ink">
                Target audience & ICP description
              </Label>
              <Textarea
                id="audience"
                value={audienceQuery}
                onChange={(e) => setAudienceQuery(e.target.value)}
                rows={3}
                placeholder="e.g. VP of Engineering and CTOs at Series A-C SaaS companies in San Francisco or Remote"
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Orbit parses specific roles, company domains, seniority, and skills for targeted scraping.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="reply-cta" className="text-xs font-medium text-ink">
                  Desired reply CTA
                </Label>
                <select
                  id="reply-cta"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={replyCta}
                  onChange={(e) => setReplyCta(e.target.value as OutreachReplyCta)}
                >
                  {OUTREACH_REPLY_CTAS.map((cta) => (
                    <option key={cta} value={cta}>
                      {REPLY_CTA_LABELS[cta]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="channel-step0" className="text-xs font-medium text-ink">
                  Primary channel
                </Label>
                <select
                  id="channel-step0"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as OutreachChannel)}
                >
                  {OUTREACH_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Follow-up Sequence Settings */}
            <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
              <label className="flex items-center gap-2 text-xs font-medium text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableSequence}
                  onChange={(e) => setEnableSequence(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                />
                Enable automated multi-step sequence (typically improves reply rates 2-3x)
              </label>

              {enableSequence && (
                <div className="grid gap-3 sm:grid-cols-2 pt-1">
                  {sequenceSteps.map((s, index) => (
                    <div key={index} className="space-y-1">
                      <Label htmlFor={`sequence-delay-${index}`} className="text-xs text-muted-foreground">
                        Follow-up #{index + 1} delay (days)
                      </Label>
                      <Input
                        id={`sequence-delay-${index}`}
                        type="number"
                        min={1}
                        value={s.delayDays}
                        onChange={(e) => {
                          const next = [...sequenceSteps];
                          next[index] = {
                            ...next[index],
                            delayDays: Math.max(1, Number(e.target.value) || 1),
                          };
                          setSequenceSteps(next);
                        }}
                        className="h-8 text-xs bg-card"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button
              onClick={handleAudienceNext}
              disabled={pending || !audienceQuery.trim()}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 shadow-xs"
            >
              Continue to Prospect Discovery
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {/* Step 1: Prospect Discovery & Live Preview */}
      {step === 1 && (
        <section className="space-y-5 rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
            <div>
              <h2 className="text-base font-semibold text-ink font-[family-name:var(--font-display)]">
                Prospect Discovery Criteria
              </h2>
              <p className="text-xs text-muted-foreground">
                Fine-tune target criteria, scrape live candidates with BrightData, and preview effectiveness scores
              </p>
            </div>
            <Button
              onClick={handleSearch}
              disabled={pending}
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs text-xs h-9"
            >
              <Search className="h-3.5 w-3.5" />
              {pending ? "Scraping & Discovering..." : "Search & Scrape Prospects"}
            </Button>
          </div>

          <AudienceFiltersEditor
            filters={filters}
            onChange={setFilters}
            showDemoWarning={hasApollo === false}
          />

          {/* Discovered Prospects Live Preview */}
          {discoveredProspects.length > 0 ? (
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink uppercase tracking-wider">
                    Discovered Prospects Preview ({discoveredProspects.length})
                  </span>
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px]">
                    <Sparkles className="mr-1 h-2.5 w-2.5 text-emerald-500 inline" />
                    Scored & Verified
                  </Badge>
                </div>
                {lastSearchSource && (
                  <span className="text-xs text-muted-foreground">
                    Engine: <strong className="text-ink capitalize">{lastSearchSource.replaceAll("_", " ")}</strong>
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {discoveredProspects.slice(0, 6).map((prospect) => {
                  const enrichment = (prospect.enrichment || {}) as Record<string, unknown>;
                  const avatarUrl = (enrichment.avatarUrl as string) || null;
                  const score = typeof enrichment.effectivenessScore === "number" ? enrichment.effectivenessScore : null;
                  const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || null;

                  return (
                    <div
                      key={prospect.id}
                      className="flex flex-col justify-between rounded-xl border border-border/70 bg-card p-3.5 text-xs shadow-2xs hover:border-border transition-all"
                    >
                      <div className="flex items-start gap-3">
                        <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-full border border-border/60 bg-muted">
                          {avatarUrl ? (
                            <img
                              src={avatarUrl}
                              alt={prospect.fullName}
                              className="h-full w-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <div className="h-full w-full flex items-center justify-center font-medium text-xs text-muted-foreground">
                              {prospect.fullName.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-medium text-ink truncate">{prospect.fullName}</span>
                            {score !== null && (
                              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums border ${
                                score >= 80
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              }`}>
                                {score}% Match
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {prospect.title || "Target Role"}
                          </p>
                          <p className="text-[11px] text-muted-foreground font-medium truncate">
                            {prospect.company || "Leading Tech Firm"}
                          </p>
                        </div>
                      </div>

                      {news && (
                        <div className="mt-2.5 pt-2 border-t border-border/40">
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 truncate flex items-center gap-1 font-medium">
                            <TrendingUp className="h-2.5 w-2.5 shrink-0" />
                            {news}
                          </p>
                        </div>
                      )}

                      {prospect.linkedinUrl && (
                        <div className="mt-2 pt-1.5 flex justify-end">
                          <a
                            href={prospect.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                          >
                            LinkedIn
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/80 bg-muted/15 p-8 text-center space-y-2">
              <Search className="mx-auto h-7 w-7 text-muted-foreground/60" />
              <p className="text-sm font-medium text-ink">No prospects discovered yet</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Click &quot;Search & Scrape Prospects&quot; to scan for real candidates matching your ICP criteria.
              </p>
            </div>
          )}

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => setStep(0)}
              disabled={pending}
              className="gap-1.5 h-10 px-4 text-xs"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Audience
            </Button>
            <Button
              onClick={() => setStep(2)}
              disabled={pending}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 shadow-xs text-xs"
            >
              Continue to Message Strategy
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {/* Step 2: Message Strategy & AI Personalization */}
      {step === 2 && (
        <section className="space-y-5 rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
          <div>
            <h2 className="text-base font-semibold text-ink font-[family-name:var(--font-display)]">
              Personalized Message Strategy
            </h2>
            <p className="text-xs text-muted-foreground">
              Define the goal of your message. AI uses recent news catalysts and shared affinity to personalize each draft.
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="intent" className="text-xs font-medium text-ink">
                Message intent & value proposition
              </Label>
              <Textarea
                id="intent"
                value={messageIntent}
                onChange={(e) => setMessageIntent(e.target.value)}
                rows={3}
                placeholder="e.g. Inquire about current engineering roadmap priorities, highlight relevant case studies, and propose a quick 10-minute intro call"
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Orbit weaves company news, funding milestones, and specific roles directly into the generated copy.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tone-step2" className="text-xs font-medium text-ink">
                  Voice & Tone
                </Label>
                <select
                  id="tone-step2"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                >
                  {OUTREACH_TONES.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="channel-step2" className="text-xs font-medium text-ink">
                  Default channel
                </Label>
                <select
                  id="channel-step2"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as OutreachChannel)}
                >
                  {OUTREACH_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="seed" className="text-xs font-medium text-ink">
                Optional template outline or prompt seed
              </Label>
              <Textarea
                id="seed"
                value={templateSeed}
                onChange={(e) => setTemplateSeed(e.target.value)}
                rows={3}
                placeholder="e.g. Hi {{name}}, saw the exciting news regarding {{company}}'s recent launch..."
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank for fully autonomous personalization, or provide key bullet points you want included.
              </p>
            </div>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => setStep(1)}
              disabled={pending}
              className="gap-1.5 h-10 px-4 text-xs"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Prospects
            </Button>
            <Button
              onClick={handleMessageNext}
              disabled={pending || !messageIntent.trim()}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 shadow-xs text-xs"
            >
              {pending ? "Writing personalized drafts..." : "Generate Drafts & Launch Campaign"}
              <Sparkles className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
