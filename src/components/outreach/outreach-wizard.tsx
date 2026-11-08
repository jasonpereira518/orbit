"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  createCampaign,
  generateOutreachDrafts,
  getCampaign,
  getOutreachBrightDataStatus,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_SEQUENCE_STEPS,
  OUTREACH_CHANNELS,
  OUTREACH_REPLY_CTAS,
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
  Briefcase,
  Check,
  Code2,
  ExternalLink,
  GraduationCap,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";

const STEPS = ["Audience", "People", "Message"] as const;

type StudentPreset = {
  id: string;
  icon: typeof Sparkles;
  title: string;
  subtitle: string;
  name: string;
  audience: string;
  intent: string;
  replyCta: OutreachReplyCta;
  tone: string;
  channel: OutreachChannel;
  templateSeed: string;
};

const STUDENT_PRESETS: StudentPreset[] = [
  {
    id: "tech",
    icon: Code2,
    title: "Tech & Software",
    subtitle: "SWE, Data & AI roles",
    name: "Tech Internship Outreach",
    audience: "Software Engineers and Tech Leads at tech companies like Google, Stripe, or Microsoft",
    intent: "Ask for a 15-minute coffee chat about their engineering team and advice for summer SWE recruiting",
    replyCta: "ask_referral",
    tone: "friendly",
    channel: "linkedin",
    templateSeed: "Hi {{name}}, I'm a student passionate about software engineering. Saw your work at {{company}} and would love to ask 2-3 quick questions about your team if you have 15 minutes for a virtual coffee chat!",
  },
  {
    id: "finance",
    icon: TrendingUp,
    title: "Finance & Banking",
    subtitle: "Investment banking & finance",
    name: "Finance & IB Networking",
    audience: "Investment Banking Analysts and Associates at Goldman Sachs, Morgan Stanley, or J.P. Morgan",
    intent: "Ask for a 15-minute informational interview about deal experience and recruiting advice",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I'm a student studying finance and economics, closely following {{company}}'s work. If your schedule allows, I would be grateful for a brief 15-minute call to hear about your analyst experience.",
  },
  {
    id: "consulting",
    icon: Briefcase,
    title: "Consulting",
    subtitle: "Strategy & business analysts",
    name: "Consulting Networking",
    audience: "Business Analysts and Consultants at McKinsey, BCG, or Bain",
    intent: "Learn about their client project experiences and case interview preparation advice",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I'm a student interested in management consulting. I saw your journey to {{company}} and would love to hear what helped you most transitioning from university into the firm.",
  },
  {
    id: "recruiting",
    icon: GraduationCap,
    title: "Campus Recruiters",
    subtitle: "Early talent & university leads",
    name: "Campus Recruiter Inquiries",
    audience: "University Campus Recruiters and Early Talent Leads at top firms",
    intent: "Inquire about upcoming university application deadlines, internship programs, and recruiter next steps",
    replyCta: "ask_referral",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I'm a student applying for upcoming internship opportunities at {{company}}. I'm reaching out to confirm the best way to submit my application for consideration.",
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

const REPLY_CTA_OPTIONS = OUTREACH_REPLY_CTAS.map((cta) => ({
  value: cta,
  label: REPLY_CTA_LABELS[cta],
}));

const CHANNEL_OPTIONS: { value: OutreachChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "sms", label: "SMS" },
];

const TONE_OPTIONS = [
  { value: "friendly", label: "Friendly & Respectful" },
  { value: "professional", label: "Professional" },
  { value: "direct", label: "Direct & Short" },
];

export function OutreachWizard({ campaignId: initialCampaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState(initialCampaignId || "");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [audienceQuery, setAudienceQuery] = useState("");
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [isLiveScraper, setIsLiveScraper] = useState<boolean | null>(null);
  const [messageIntent, setMessageIntent] = useState("");
  const [replyCta, setReplyCta] = useState<OutreachReplyCta>("book_intro");
  const [tone, setTone] = useState("friendly");
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
    getOutreachBrightDataStatus()
      .then((s) => setIsLiveScraper(s.isConfigured))
      .catch(() => setIsLiveScraper(false));
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
      // Non-blocking
    }
  }

  function applyPreset(preset: StudentPreset) {
    setSelectedPreset(preset.id);
    setName(preset.name);
    setAudienceQuery(preset.audience);
    setMessageIntent(preset.intent);
    setReplyCta(preset.replyCta);
    setTone(preset.tone);
    setChannel(preset.channel);
    setTemplateSeed(preset.templateSeed);
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
            name: name.trim() || "Untitled Campaign",
            audienceQuery,
            replyCta,
            sequenceSteps: enableSequence ? sequenceSteps : [],
          });
          setCampaignId(campaign.id);
          setFilters((campaign.audienceFilters as AudienceFilters) || {});
          await loadCampaignData(campaign.id);
          setStep(1);
        } else {
          const updated = await updateCampaign(campaignId, {
            name: name.trim() || "Untitled Campaign",
            audienceQuery,
            replyCta,
            sequenceSteps: enableSequence ? sequenceSteps : [],
          });
          setFilters((updated.audienceFilters as AudienceFilters) || {});
          await loadCampaignData(campaignId);
          setStep(1);
        }
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't save audience"));
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
        toast.success(`Found ${result.matched} people matching criteria`);
      } catch (err) {
        toast.error(friendlyError(err, "Search failed"));
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
        goToCampaign(campaignId);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't write drafts"));
      }
    });
  }

  const stepProgress = STEPS.map((_, i) => {
    if (i < step) return 1;
    if (i > step) return 0;
    if (i === 0) {
      const filled = (name.trim() ? 0.4 : 0) + (audienceQuery.trim() ? 0.6 : 0);
      return Math.min(1, Math.max(0.15, filled));
    }
    if (i === 1) {
      return discoveredProspects.length > 0 ? 1 : pending ? 0.6 : 0.2;
    }
    if (i === 2) {
      return messageIntent.trim() ? 1 : 0.3;
    }
    return 0.1;
  });

  return (
    <div className="space-y-6">
      {/* Minimal Step Indicator */}
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
              <div className="flex items-baseline justify-between text-xs">
                <span
                  className={`font-medium ${
                    isCurrent
                      ? "text-primary font-semibold"
                      : isDone
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  {i + 1}. {label}
                </span>
                <span className="text-3xs tabular-nums text-muted-foreground">
                  {Math.round(value * 100)}%
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(value * 100)}
              >
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isCurrent || isDone ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
                  style={{ width: `${Math.round(value * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Step 0: Audience */}
      {step === 0 && (
        <section className="space-y-5 rounded-3xl border border-border/70 bg-card p-6 shadow-xs">
          {/* Quick Presets */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground block">
              Quick template (optional)
            </Label>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {STUDENT_PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = selectedPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`flex flex-col text-left rounded-2xl border p-3 transition-all text-xs ${
                      isSelected
                        ? "border-primary bg-primary/5 ring-1 ring-primary shadow-xs"
                        : "border-border/60 bg-muted/20 hover:border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                      {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                    </div>
                    <span className="font-semibold text-ink text-xs">{preset.title}</span>
                    <span className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">
                      {preset.subtitle}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3.5 pt-1">
            <div className="space-y-1">
              <Label htmlFor="campaign-name" className="text-xs font-medium text-ink">
                Campaign name
              </Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Summer 2027 SWE Internships or Goldman Sachs Networking"
                className="h-10 text-xs rounded-xl"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="audience" className="text-xs font-medium text-ink">
                Who do you want to reach?
              </Label>
              <Textarea
                id="audience"
                value={audienceQuery}
                onChange={(e) => setAudienceQuery(e.target.value)}
                rows={2}
                placeholder="e.g. Software engineers at Stripe, or Investment banking analysts at Goldman Sachs"
                className="text-xs rounded-xl"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label id="reply-cta-label" className="text-xs font-medium text-ink">
                  Goal / Next step
                </Label>
                <Select
                  value={replyCta}
                  onValueChange={(v) => {
                    if (v) setReplyCta(v as OutreachReplyCta);
                  }}
                  items={REPLY_CTA_OPTIONS}
                >
                  <SelectTrigger aria-labelledby="reply-cta-label" className="h-10 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-xs shadow-2xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                    {REPLY_CTA_OPTIONS.map((cta) => (
                      <SelectItem key={cta.value} value={cta.value} className="py-1.5 pl-2 rounded-lg text-xs">
                        {cta.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label id="channel-step0-label" className="text-xs font-medium text-ink">
                  Channel
                </Label>
                <Select
                  value={channel}
                  onValueChange={(v) => {
                    if (v) setChannel(v as OutreachChannel);
                  }}
                  items={CHANNEL_OPTIONS}
                >
                  <SelectTrigger aria-labelledby="channel-step0-label" className="h-10 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-xs shadow-2xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                    {CHANNEL_OPTIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value} className="py-1.5 pl-2 rounded-lg text-xs">
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="pt-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableSequence}
                  onChange={(e) => setEnableSequence(e.target.checked)}
                  className="rounded-md border-border text-primary h-3.5 w-3.5"
                />
                Send a polite follow-up if no reply after 3 days
              </label>
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-border/40">
            <Button
              onClick={handleAudienceNext}
              disabled={pending || !audienceQuery.trim()}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 text-xs font-medium rounded-full shadow-xs"
            >
              Next: Find People
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </section>
      )}

      {/* Step 1: People */}
      {step === 1 && (
        <section className="space-y-5 rounded-3xl border border-border/70 bg-card p-6 shadow-xs">
          <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Find People
              </h2>
              <p className="text-xs text-muted-foreground">
                Search matching professionals and recruiters with BrightData
              </p>
            </div>
            <Button
              onClick={handleSearch}
              disabled={pending}
              size="sm"
              className="gap-1.5 h-8 px-4 text-xs rounded-full shadow-2xs"
            >
              <Search className="h-3 w-3" />
              {pending ? "Searching..." : "Search People"}
            </Button>
          </div>

          <AudienceFiltersEditor
            filters={filters}
            onChange={setFilters}
            showDemoWarning={isLiveScraper === false}
          />

          {/* People Found Preview */}
          {discoveredProspects.length > 0 ? (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-semibold text-ink">
                  {discoveredProspects.length} people found
                </span>
                {lastSearchSource && (
                  <span className="capitalize">
                    Source: {lastSearchSource.replaceAll("_", " ")}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {discoveredProspects.slice(0, 6).map((prospect) => {
                  const enrichment = (prospect.enrichment || {}) as Record<string, unknown>;
                  const avatarUrl = (enrichment.avatarUrl as string) || null;
                  const score = typeof enrichment.effectivenessScore === "number" ? enrichment.effectivenessScore : null;
                  const reasons = (enrichment.scoreReasons as string[]) || [];
                  const matchReason = (enrichment.matchReason as string) || reasons[0] || null;
                  const summary = (enrichment.summary as string) || (enrichment.headline as string) || null;
                  const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || null;
                  const signals = Array.isArray(enrichment.signals) ? (enrichment.signals as string[]) : [];

                  return (
                    <div
                      key={prospect.id}
                      className="flex flex-col justify-between rounded-2xl border border-border/70 bg-card p-4 text-xs shadow-2xs hover:border-border transition-all gap-3"
                    >
                      <div className="space-y-2.5">
                        <div className="flex items-start gap-3">
                          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full border border-border/60 bg-muted">
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
                              <div className="h-full w-full flex items-center justify-center font-semibold text-xs text-muted-foreground">
                                {prospect.fullName.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="font-semibold text-ink truncate text-sm">{prospect.fullName}</span>
                              {score !== null && (
                                <span
                                  title={reasons.join(" • ") || "Match score"}
                                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums border ${
                                    score >= 80
                                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                      : score >= 60
                                      ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                      : "border-border/60 bg-muted/40 text-muted-foreground"
                                  }`}
                                >
                                  <Sparkles className="h-2.5 w-2.5 inline mr-1 text-emerald-500" />
                                  {score}% Match
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-ink/80 font-medium truncate mt-0.5">
                              {prospect.title || "Target Role"}
                            </p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              <span className="font-medium text-ink">{prospect.company || "Target Company"}</span>
                              {prospect.location && (
                                <>
                                  <span className="mx-1 text-border">·</span>
                                  <span>{prospect.location}</span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>

                        {/* Bio / Summary context */}
                        {summary && (
                          <p className="text-[11.5px] text-muted-foreground line-clamp-2 leading-relaxed">
                            {summary}
                          </p>
                        )}

                        {/* Match Reason and Growth Signals */}
                        {(matchReason || signals.length > 0) && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {matchReason && (
                              <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary">
                                {matchReason}
                              </span>
                            )}
                            {signals.slice(0, 2).map((sig) => (
                              <span key={sig} className="rounded-full border border-border/40 bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                                {sig}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Recent News Catalyst */}
                        {news && (
                          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                            <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
                            <span className="truncate">{news}</span>
                          </div>
                        )}
                      </div>

                      {/* Footer: Details & LinkedIn links */}
                      <div className="flex items-center justify-between pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
                        <span className="truncate max-w-[180px]">
                          {prospect.email ? (
                            <span className="text-ink font-mono text-[10px]">{prospect.email}</span>
                          ) : (
                            <span>Verified public profile</span>
                          )}
                        </span>
                        {prospect.linkedinUrl && (
                          <a
                            href={prospect.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline font-medium shrink-0"
                          >
                            LinkedIn
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
              Click &quot;Search People&quot; to preview matching professionals
            </div>
          )}

          <div className="flex justify-between items-center pt-3 border-t border-border/40">
            <Button
              variant="outline"
              onClick={() => setStep(0)}
              disabled={pending}
              size="sm"
              className="gap-1.5 h-9 px-4 text-xs rounded-full"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </Button>
            <Button
              onClick={() => setStep(2)}
              disabled={pending}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 text-xs font-medium rounded-full shadow-xs"
            >
              Next: Draft Message
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </section>
      )}

      {/* Step 2: Message */}
      {step === 2 && (
        <section className="space-y-5 rounded-3xl border border-border/70 bg-card p-6 shadow-xs">
          <div className="border-b border-border/40 pb-2.5">
            <h2 className="text-sm font-semibold text-ink">
              Message Strategy
            </h2>
            <p className="text-xs text-muted-foreground">
              AI writes a personalized note for each person
            </p>
          </div>

          <div className="space-y-3.5">
            <div className="space-y-1">
              <Label htmlFor="intent" className="text-xs font-medium text-ink">
                What do you want to ask? (Message intent)
              </Label>
              <Textarea
                id="intent"
                value={messageIntent}
                onChange={(e) => setMessageIntent(e.target.value)}
                rows={2}
                placeholder="e.g. Ask for a 15-minute coffee chat about their team and recruiting advice"
                className="text-xs rounded-xl"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label id="tone-step2-label" className="text-xs font-medium text-ink">
                  Tone
                </Label>
                <Select
                  value={tone}
                  onValueChange={(v) => {
                    if (v) setTone(v);
                  }}
                  items={TONE_OPTIONS}
                >
                  <SelectTrigger aria-labelledby="tone-step2-label" className="h-10 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-xs shadow-2xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                    {TONE_OPTIONS.map((t) => (
                      <SelectItem key={t.value} value={t.value} className="py-1.5 pl-2 rounded-lg text-xs">
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label id="channel-step2-label" className="text-xs font-medium text-ink">
                  Channel
                </Label>
                <Select
                  value={channel}
                  onValueChange={(v) => {
                    if (v) setChannel(v as OutreachChannel);
                  }}
                  items={CHANNEL_OPTIONS}
                >
                  <SelectTrigger aria-labelledby="channel-step2-label" className="h-10 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-xs shadow-2xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                    {CHANNEL_OPTIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value} className="py-1.5 pl-2 rounded-lg text-xs">
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="seed" className="text-xs font-medium text-ink">
                  Starter template (optional)
                </Label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setTemplateSeed(
                        "Hi {{name}}, I'm a student interested in {{company}}'s work. If you have 15 minutes, I'd love to ask a couple of quick questions about your team over a virtual coffee chat!"
                      )
                    }
                    className="rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] text-foreground hover:bg-muted font-medium transition-colors"
                  >
                    Coffee Chat
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setTemplateSeed(
                        "Hi {{name}}, I'm applying for upcoming internship roles at {{company}} and saw your work on the team. I would be grateful for any advice on the interview process if your schedule allows."
                      )
                    }
                    className="rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] text-foreground hover:bg-muted font-medium transition-colors"
                  >
                    Internship Advice
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setTemplateSeed(
                        "Hi {{name}}, I noticed we share an alumni connection! As a student exploring careers in your field, I would love to hear what surprised you most about joining {{company}}."
                      )
                    }
                    className="rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] text-foreground hover:bg-muted font-medium transition-colors"
                  >
                    Alumni Connect
                  </button>
                </div>
              </div>

              <Textarea
                id="seed"
                value={templateSeed}
                onChange={(e) => setTemplateSeed(e.target.value)}
                rows={2}
                placeholder="Leave blank for automatic draft, or provide a template outline..."
                className="text-xs rounded-xl"
              />
            </div>
          </div>

          <div className="flex justify-between items-center pt-3 border-t border-border/40">
            <Button
              variant="outline"
              onClick={() => setStep(1)}
              disabled={pending}
              size="sm"
              className="gap-1.5 h-9 px-4 text-xs rounded-full"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </Button>
            <Button
              onClick={handleMessageNext}
              disabled={pending || !messageIntent.trim()}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 text-xs font-medium rounded-full shadow-xs"
            >
              {pending ? "Writing Drafts..." : "Generate Drafts & Open Campaign"}
              <Sparkles className="h-3.5 w-3.5" />
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
