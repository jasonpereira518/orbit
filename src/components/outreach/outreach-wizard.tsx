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
  Briefcase,
  Check,
  Code2,
  Coffee,
  Compass,
  ExternalLink,
  GraduationCap,
  Lightbulb,
  Search,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

const STEPS = ["Target Audience", "Prospect Discovery", "Message Strategy"] as const;

type TrackId = "all" | "tech" | "business" | "alumni";

const TRACKS = [
  { id: "all" as TrackId, label: "🌟 All Goals" },
  { id: "tech" as TrackId, label: "💻 Tech & Software" },
  { id: "business" as TrackId, label: "💼 Business & Finance" },
  { id: "alumni" as TrackId, label: "🎓 Alumni & Recruiters" },
] as const;

type StudentPreset = {
  id: string;
  track: "tech" | "business" | "alumni";
  badge: string;
  icon: typeof Sparkles;
  title: string;
  name: string;
  audience: string;
  intent: string;
  replyCta: OutreachReplyCta;
  tone: string;
  channel: OutreachChannel;
  templateSeed: string;
};

const STUDENT_CAMPAIGN_PRESETS: StudentPreset[] = [
  // Tech Track
  {
    id: "swe_internship",
    track: "tech",
    badge: "Tech / SWE",
    icon: Code2,
    title: "SWE Internship & New Grad",
    name: "Summer 2027 SWE Internship Outreach",
    audience: "Software Engineers and Tech Leads at companies like Google, Stripe, Meta, or Microsoft",
    intent: "Ask for a 15-minute coffee chat about their engineering team culture and advice on the summer SWE intern recruiting process",
    replyCta: "ask_referral",
    tone: "friendly",
    channel: "linkedin",
    templateSeed: "Hi {{name}}, I'm a student passionate about software engineering. Saw your recent work at {{company}} and would love to ask 2-3 quick questions about your team's tech stack and engineering culture if you have 15 minutes for a virtual coffee chat!",
  },
  {
    id: "ai_data",
    track: "tech",
    badge: "Tech / AI & Data",
    icon: Sparkles,
    title: "AI, ML & Data Science",
    name: "AI & Machine Learning Career Outreach",
    audience: "Data Scientists and Machine Learning Engineers at AI and tech companies",
    intent: "Inquire about applied AI project workflows, model deployment challenges, and advice for students breaking into ML",
    replyCta: "book_intro",
    tone: "friendly",
    channel: "email",
    templateSeed: "Hi {{name}}, I've been following {{company}}'s recent developments in AI. As a student building machine learning projects, I'd love to learn how your team approaches model evaluation in production if you have a brief moment.",
  },
  // Business Track
  {
    id: "finance_ib",
    track: "business",
    badge: "Business / Finance",
    icon: TrendingUp,
    title: "Investment Banking & Finance",
    name: "Investment Banking & Finance Networking",
    audience: "Investment Banking Analysts and Associates at Goldman Sachs, Morgan Stanley, or J.P. Morgan",
    intent: "Conduct a 15-minute informational interview about deal flow, analyst experience, and recruiting timeline advice",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I hope you're having a great week. I'm a student studying finance and economics, and I've been closely following {{company}}'s advisory work. If your schedule permits, I would be grateful for a brief 15-minute conversation to hear about your analyst experience.",
  },
  {
    id: "consulting",
    track: "business",
    badge: "Business / Consulting",
    icon: Briefcase,
    title: "Management Consulting & Strategy",
    name: "Management Consulting Networking",
    audience: "Business Analysts, Consultants, and Strategy Associates at McKinsey, BCG, or Bain",
    intent: "Learn about their client engagement experiences and case interview preparation guidance",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I am a student interested in management consulting and strategic advisory. I saw your journey to {{company}} and would love to hear how you transitioned from university and what case problem types you enjoy most.",
  },
  {
    id: "product_bizops",
    track: "business",
    badge: "Business & Tech",
    icon: Compass,
    title: "Product Management (APM)",
    name: "Associate Product Manager (APM) Outreach",
    audience: "Associate Product Managers (APM) and Product Managers at technology companies",
    intent: "Ask about product prioritization, day-to-day cross-functional collaboration, and APM recruiting advice",
    replyCta: "book_intro",
    tone: "friendly",
    channel: "linkedin",
    templateSeed: "Hi {{name}}, I'm an aspiring product manager studying tech and business. I admire the user experience of {{company}}'s products and would love to ask how you break down user problems and what skills helped you most when starting out.",
  },
  // Alumni & Campus Track
  {
    id: "alumni_chat",
    track: "alumni",
    badge: "Alumni / All Majors",
    icon: Coffee,
    title: "Alumni Coffee Chat (Any Major)",
    name: "University Alumni Coffee Chats",
    audience: "Alumni from my university working in tech, finance, consulting, or marketing",
    intent: "Connect as a fellow student/alumnus to learn about their career path post-graduation and ask for general advice",
    replyCta: "book_intro",
    tone: "friendly",
    channel: "email",
    templateSeed: "Hi {{name}}, I noticed you also attended our university! As a current student exploring career paths in {{company}}'s field, I'd love to hear about your transition after graduation over a quick 15-minute virtual chat.",
  },
  {
    id: "campus_recruiters",
    track: "alumni",
    badge: "Recruiting",
    icon: GraduationCap,
    title: "University Campus Recruiters",
    name: "Campus Talent & Recruiter Inquiries",
    audience: "University Campus Recruiters and Early Talent Acquisition leads at target firms",
    intent: "Inquire about upcoming university application deadlines, internship programs, and application next steps",
    replyCta: "ask_referral",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I'm a student applying for upcoming internship opportunities at {{company}}. I'm reaching out to confirm the best way to submit my application for consideration and would appreciate any guidance on the process.",
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
  const [selectedTrack, setSelectedTrack] = useState<TrackId>("all");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [audienceQuery, setAudienceQuery] = useState("");
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [hasApollo, setHasApollo] = useState<boolean | null>(null);
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

  function applyPreset(preset: StudentPreset) {
    setSelectedPreset(preset.id);
    setName(preset.name);
    setAudienceQuery(preset.audience);
    setMessageIntent(preset.intent);
    setReplyCta(preset.replyCta);
    setTone(preset.tone);
    setChannel(preset.channel);
    setTemplateSeed(preset.templateSeed);
    toast.success(`Loaded "${preset.title}" template — customize any detail below!`);
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
          toast.success("Goal saved! Now discover people to reach out to.");
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
        toast.error(friendlyError(err, "Couldn’t save that goal — try again?"));
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

        toast.success(
          `Found ${result.matched} matching professionals` +
            (result.mismatched ? ` (${result.mismatched} filtered out)` : "")
        );
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
        toast.success("Personalized drafts generated — opening campaign!");
        goToCampaign(campaignId);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t write those drafts — try again?"));
      }
    });
  }

  const filteredPresets = selectedTrack === "all"
    ? STUDENT_CAMPAIGN_PRESETS
    : STUDENT_CAMPAIGN_PRESETS.filter((p) => p.track === selectedTrack);

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
      {/* Visual Step Progress Tracker */}
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

      {/* Step 0: Target Audience & Student Goal */}
      {step === 0 && (
        <section className="space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
          {/* Goal & Major Track Selector */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Label className="text-xs font-semibold text-ink uppercase tracking-wider block">
                  What is your campaign goal?
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Choose a starter template or describe your own target role and companies
                </p>
              </div>

              {/* Major Track Filter Pills */}
              <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1 text-xs">
                {TRACKS.map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => setSelectedTrack(track.id)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      selectedTrack === track.id
                        ? "bg-card text-foreground shadow-2xs font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {track.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Presets Grid */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {filteredPresets.map((preset) => {
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
                        : "border-border/60 bg-muted/15 hover:border-border hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                        <Icon className="h-3.5 w-3.5" />
                        {preset.badge}
                      </span>
                      {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                    </div>
                    <span className="font-semibold text-ink text-xs">{preset.title}</span>
                    <span className="text-[11px] text-muted-foreground line-clamp-2 mt-1">
                      {preset.intent}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-4 pt-2 border-t border-border/40">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name" className="text-xs font-medium text-ink">
                Campaign name
              </Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Summer 2027 SWE Internships or Goldman Sachs IB Networking"
                className="h-10 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="audience" className="text-xs font-medium text-ink">
                  Who do you want to connect with?
                </Label>
                <span className="text-3xs text-muted-foreground">Target specific roles & firms</span>
              </div>
              <Textarea
                id="audience"
                value={audienceQuery}
                onChange={(e) => setAudienceQuery(e.target.value)}
                rows={3}
                placeholder="e.g. Software engineers and engineering managers at Stripe in San Francisco or Remote, or Investment Banking Analysts at Goldman Sachs in New York"
                className="text-sm"
              />
              <div className="flex items-start gap-1.5 rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
                <Lightbulb className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                <span>
                  <strong>Tip for students:</strong> Reaching out to alumni, analysts, or campus recruiters who graduated 1–3 years ago gives the highest reply rates!
                </span>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="reply-cta" className="text-xs font-medium text-ink">
                  Desired next step / Call to action
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
                  Preferred outreach channel
                </Label>
                <select
                  id="channel-step0"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as OutreachChannel)}
                >
                  {OUTREACH_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c === "email" ? "Email (Gmail / Outlook)" : c === "linkedin" ? "LinkedIn (Connection & Message)" : "SMS"}
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
                Enable automated friendly follow-up (busy professionals often appreciate a polite reminder after 3-4 days!)
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
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 shadow-xs text-xs font-medium"
            >
              Continue to Discover People
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {/* Step 1: Discover & Review Professionals */}
      {step === 1 && (
        <section className="space-y-5 rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
            <div>
              <h2 className="text-base font-semibold text-ink font-[family-name:var(--font-display)]">
                Discover Professionals
              </h2>
              <p className="text-xs text-muted-foreground">
                Orbit finds verified public profiles and company news so your message feels authentic and informed
              </p>
            </div>
            <Button
              onClick={handleSearch}
              disabled={pending}
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs text-xs h-9"
            >
              <Search className="h-3.5 w-3.5" />
              {pending ? "Finding Professionals..." : "Search & Find People"}
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
                    People Found ({discoveredProspects.length})
                  </span>
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px]">
                    <Sparkles className="mr-1 h-2.5 w-2.5 text-emerald-500 inline" />
                    Scored for Student Match
                  </Badge>
                </div>
                {lastSearchSource && (
                  <span className="text-xs text-muted-foreground">
                    Source: <strong className="text-ink capitalize">{lastSearchSource.replaceAll("_", " ")}</strong>
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {discoveredProspects.slice(0, 6).map((prospect) => {
                  const enrichment = (prospect.enrichment || {}) as Record<string, unknown>;
                  const avatarUrl = (enrichment.avatarUrl as string) || null;
                  const score = typeof enrichment.effectivenessScore === "number" ? enrichment.effectivenessScore : null;
                  const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || null;
                  const reasons = (enrichment.scoreReasons as string[]) || [];

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
                            <span className="font-semibold text-ink truncate">{prospect.fullName}</span>
                            {score !== null && (
                              <span
                                title={reasons.join(" • ") || "Match score"}
                                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums border ${
                                  score >= 80
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                }`}
                              >
                                {score}% Match
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5 font-medium">
                            {prospect.title || "Target Role"}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {prospect.company || "Target Company"}
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
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-medium"
                          >
                            View on LinkedIn
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
              <p className="text-sm font-semibold text-ink">No professionals discovered yet</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Click &quot;Search & Find People&quot; above to find real professionals and recruiters matching your criteria.
              </p>
            </div>
          )}

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => setStep(0)}
              disabled={pending}
              className="gap-1.5 h-10 px-4 text-xs font-medium"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Audience
            </Button>
            <Button
              onClick={() => setStep(2)}
              disabled={pending}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 shadow-xs text-xs font-medium"
            >
              Continue to Message Strategy
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {/* Step 2: Message Strategy & Personalized Drafts */}
      {step === 2 && (
        <section className="space-y-5 rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
          <div>
            <h2 className="text-base font-semibold text-ink font-[family-name:var(--font-display)]">
              Personalized Message Strategy
            </h2>
            <p className="text-xs text-muted-foreground">
              Define what you want to say. AI will write a unique, personalized note for each person referencing their role and company.
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="intent" className="text-xs font-medium text-ink">
                What is your message goal? (Message intent)
              </Label>
              <Textarea
                id="intent"
                value={messageIntent}
                onChange={(e) => setMessageIntent(e.target.value)}
                rows={3}
                placeholder="e.g. Introduce myself as a student interested in software engineering or consulting, ask for a 15-minute coffee chat to learn about their team, and see if they have recruiting advice"
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Orbit weaves in recent company milestones (deals, launches) and their specific role to make each message feel personal.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tone-step2" className="text-xs font-medium text-ink">
                  Tone
                </Label>
                <select
                  id="tone-step2"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                >
                  <option value="friendly">Friendly & Respectful (Recommended for students & alumni)</option>
                  <option value="professional">Professional & Polished (Great for finance & consulting)</option>
                  <option value="direct">Direct & Concise (Best for founders & busy engineers)</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="channel-step2" className="text-xs font-medium text-ink">
                  Default delivery channel
                </Label>
                <select
                  id="channel-step2"
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as OutreachChannel)}
                >
                  {OUTREACH_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c === "email" ? "Email (Gmail / Outlook)" : c === "linkedin" ? "LinkedIn" : "SMS"}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="seed" className="text-xs font-medium text-ink">
                  Template outline or starter note (optional)
                </Label>
                <span className="text-3xs text-muted-foreground">Pick a starter or write your own</span>
              </div>

              {/* Starter Template Pills */}
              <div className="flex flex-wrap gap-2 pb-1">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    setTemplateSeed(
                      "Hi {{name}}, I'm a student interested in {{company}}'s work. I'd love to ask 2-3 quick questions about your team and your career path over a brief 15-minute virtual coffee chat if you have time!"
                    )
                  }
                  className="text-xs gap-1"
                >
                  <Coffee className="h-3 w-3 text-primary" />
                  ☕ 15-Min Coffee Chat
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    setTemplateSeed(
                      "Hi {{name}}, I'm applying for upcoming internship roles at {{company}} and saw your impressive work on the team. If your schedule allows, I would be grateful for any advice on the team's interview process."
                    )
                  }
                  className="text-xs gap-1"
                >
                  <GraduationCap className="h-3 w-3 text-primary" />
                  📄 Internship Advice
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    setTemplateSeed(
                      "Hi {{name}}, I noticed we share an alumni connection! As a student exploring careers in your field, I would love to hear what surprised you most transitioning into {{company}}."
                    )
                  }
                  className="text-xs gap-1"
                >
                  <Users className="h-3 w-3 text-primary" />
                  🎓 Fellow Alum Connection
                </Button>
              </div>

              <Textarea
                id="seed"
                value={templateSeed}
                onChange={(e) => setTemplateSeed(e.target.value)}
                rows={3}
                placeholder="Hi {{name}}, I'm reaching out because I saw your work at {{company}}..."
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to let AI draft from scratch, or provide an outline you want customized for each recipient.
              </p>
            </div>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => setStep(1)}
              disabled={pending}
              className="gap-1.5 h-10 px-4 text-xs font-medium"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Prospects
            </Button>
            <Button
              onClick={handleMessageNext}
              disabled={pending || !messageIntent.trim()}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 shadow-xs text-xs font-medium"
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
