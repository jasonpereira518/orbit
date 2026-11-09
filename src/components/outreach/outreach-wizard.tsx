"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  createCampaign,
  generateOutreachDrafts,
  getCampaign,
  getOutreachBrightDataStatus,
  runCampaignDeepSearchAction,
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
  Clock,
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

const STEPS = ["Audience", "People", "Message"] as const;

type TrackId = "all" | "tech" | "business" | "alumni";

const TRACKS: { id: TrackId; label: string }[] = [
  { id: "all", label: "All Goals" },
  { id: "tech", label: "Tech & Software" },
  { id: "business", label: "Business & Finance" },
  { id: "alumni", label: "Alumni & Recruiting" },
];

type StudentPreset = {
  id: string;
  track: "tech" | "business" | "alumni";
  badge: string;
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
    id: "swe_internship",
    track: "tech",
    badge: "Tech / SWE",
    icon: Code2,
    title: "SWE Internship & Full-time",
    subtitle: "Software engineers, systems & tech leads",
    name: "Summer 2027 SWE Internship Outreach",
    audience: "Software Engineers and Tech Leads at tech companies like Google, Stripe, Meta, or Microsoft",
    intent: "Ask for a 15-minute coffee chat about their engineering team culture and advice on the summer SWE intern recruiting process",
    replyCta: "ask_referral",
    tone: "friendly",
    channel: "linkedin",
    templateSeed: "Hi {{name}}, I'm a student passionate about software engineering. Saw your work at {{company}} and would love to ask 2-3 quick questions about your team's tech stack and engineering culture if you have 15 minutes for a virtual coffee chat!",
  },
  {
    id: "ai_ml",
    track: "tech",
    badge: "Tech / AI & ML",
    icon: Sparkles,
    title: "AI, ML & Data Science",
    subtitle: "Applied ML, research & data platforms",
    name: "AI & Machine Learning Career Outreach",
    audience: "Data Scientists and Machine Learning Engineers at AI and tech companies",
    intent: "Inquire about applied AI project workflows, model deployment challenges, and advice for students breaking into ML",
    replyCta: "book_intro",
    tone: "friendly",
    channel: "email",
    templateSeed: "Hi {{name}}, I've been following {{company}}'s recent developments in AI. As a student building machine learning projects, I'd love to learn how your team approaches model evaluation in production if you have a brief moment.",
  },
  {
    id: "finance_ib",
    track: "business",
    badge: "Finance / Banking",
    icon: TrendingUp,
    title: "Investment Banking & Finance",
    subtitle: "M&A, coverage & capital markets analysts",
    name: "Investment Banking & Finance Networking",
    audience: "Investment Banking Analysts and Associates at Goldman Sachs, Morgan Stanley, or J.P. Morgan",
    intent: "Conduct a 15-minute informational interview about deal flow, analyst experience, and recruiting timeline advice",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I'm a student studying finance and economics, closely following {{company}}'s advisory work. If your schedule permits, I would be grateful for a brief 15-minute conversation to hear about your analyst experience.",
  },
  {
    id: "consulting",
    track: "business",
    badge: "Strategy / Consulting",
    icon: Briefcase,
    title: "Management Consulting",
    subtitle: "Strategy, business analysts & associates",
    name: "Management Consulting Networking",
    audience: "Business Analysts, Consultants, and Strategy Associates at McKinsey, BCG, or Bain",
    intent: "Learn about their client engagement experiences and case interview preparation guidance",
    replyCta: "book_intro",
    tone: "professional",
    channel: "email",
    templateSeed: "Hi {{name}}, I am a student interested in management consulting and strategic advisory. I saw your journey to {{company}} and would love to hear how you transitioned from university and what case problem types you enjoy most.",
  },
  {
    id: "product_mgmt",
    track: "business",
    badge: "Business & Tech",
    icon: Compass,
    title: "Product Management (APM)",
    subtitle: "Associate PMs & product strategists",
    name: "Associate Product Manager (APM) Outreach",
    audience: "Associate Product Managers (APM) and Product Managers at technology companies",
    intent: "Ask about product prioritization, day-to-day cross-functional collaboration, and APM recruiting advice",
    replyCta: "book_intro",
    tone: "friendly",
    channel: "linkedin",
    templateSeed: "Hi {{name}}, I'm an aspiring product manager studying tech and business. I admire the user experience of {{company}}'s products and would love to ask how you break down user problems and what skills helped you most when starting out.",
  },
  {
    id: "alumni_chat",
    track: "alumni",
    badge: "Alumni / All Majors",
    icon: Coffee,
    title: "University Alumni Network",
    subtitle: "Alumni across all industries & majors",
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
    badge: "Recruiter Direct",
    icon: GraduationCap,
    title: "Campus & Early Talent Recruiters",
    subtitle: "University recruiters & talent acquisition",
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
  { value: "professional", label: "Professional & Structured" },
  { value: "direct", label: "Direct & Short" },
  { value: "casual", label: "Casual & Warm" },
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
  const [selectedTrack, setSelectedTrack] = useState<TrackId>("all");
  const [matchPriorityFilter, setMatchPriorityFilter] = useState<"all" | "high" | "strong">("all");
  const [selectedProspectIds, setSelectedProspectIds] = useState<Set<string>>(new Set());
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
          setSelectedProspectIds(new Set(camp.prospects.map((p) => p.id)));
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

  const filteredProspects = useMemo(() => {
    let list = discoveredProspects;
    if (matchPriorityFilter === "high") {
      list = list.filter((p) => {
        const score = ((p.enrichment || {}) as any).effectivenessScore;
        return typeof score === "number" && score >= 80;
      });
    } else if (matchPriorityFilter === "strong") {
      list = list.filter((p) => {
        const score = ((p.enrichment || {}) as any).effectivenessScore;
        return typeof score === "number" && score >= 60;
      });
    }
    return list;
  }, [discoveredProspects, matchPriorityFilter]);

  function toggleProspectSelection(id: string) {
    setSelectedProspectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllProspects() {
    if (selectedProspectIds.size === filteredProspects.length) {
      setSelectedProspectIds(new Set());
    } else {
      setSelectedProspectIds(new Set(filteredProspects.map((p) => p.id)));
    }
  }

  function insertVariable(token: string) {
    setTemplateSeed((prev) => (prev ? `${prev} ${token}` : token));
  }

  function handleDeepSearch() {
    if (!campaignId) return;
    start(async () => {
      try {
        toast.message("Scanning web and company news for catalysts...");
        const result = await runCampaignDeepSearchAction(campaignId);
        await loadCampaignData(campaignId);
        toast.success(result.message);
      } catch (err) {
        toast.error(friendlyError(err, "Deep search failed"));
      }
    });
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
          {/* Quick Presets with Goal Tracks */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs font-medium text-muted-foreground block">
                Starter campaign templates
              </Label>
              <div className="flex items-center gap-1">
                {TRACKS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTrack(t.id)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                      selectedTrack === t.id
                        ? "bg-primary text-primary-foreground shadow-2xs"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-ink"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {STUDENT_PRESETS.filter((p) => selectedTrack === "all" || p.track === selectedTrack).map((preset) => {
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
                      <div className="flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5 text-primary" />
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          {preset.badge}
                        </span>
                      </div>
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

            <div className="space-y-3 pt-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableSequence}
                  onChange={(e) => setEnableSequence(e.target.checked)}
                  className="rounded-md border-border text-primary h-3.5 w-3.5"
                />
                <span className="font-medium text-ink">Enable automated follow-up sequence</span>
                <span className="text-muted-foreground text-[11px]">(2.4x higher reply rates for student outreach)</span>
              </label>

              {enableSequence && (
                <div className="rounded-2xl border border-border/70 bg-muted/20 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-ink flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-primary" />
                      Sequence Schedule
                    </span>
                    <span className="text-[11px] text-muted-foreground">Auto-pauses on reply</span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-xl border border-border/60 bg-card p-2.5 text-xs space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="font-semibold text-ink">Step 1 · Initial</span>
                        <span className="font-mono text-[10px] text-primary">Day 0</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Personalized intro tailored to their specific role, company, and catalysts.
                      </p>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-card p-2.5 text-xs space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="font-semibold text-ink">Step 2 · Nudge</span>
                        <span className="font-mono text-[10px] text-primary">+{sequenceSteps[0]?.delayDays || 3} days</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Gentle check-in referencing your prior note with added conversational context.
                      </p>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-card p-2.5 text-xs space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="font-semibold text-ink">Step 3 · Wrap-up</span>
                        <span className="font-mono text-[10px] text-primary">+{sequenceSteps[1]?.delayDays || 7} days</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Polite wrap-up keeping the door open for future opportunities.
                      </p>
                    </div>
                  </div>
                </div>
              )}
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Find Professionals
              </h2>
              <p className="text-xs text-muted-foreground">
                Verified public profiles with recent company catalysts and growth signals
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleDeepSearch}
                disabled={pending || !campaignId}
                size="sm"
                className="gap-1.5 h-8 px-3 text-xs rounded-full shadow-2xs"
              >
                <Compass className="h-3 w-3 text-primary" />
                {pending ? "Scanning..." : "Deep Search (Web & News)"}
              </Button>
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
          </div>

          <AudienceFiltersEditor
            filters={filters}
            onChange={setFilters}
            showDemoWarning={isLiveScraper === false}
          />

          {/* People Found Preview */}
          {discoveredProspects.length > 0 ? (
            <div className="space-y-3 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">
                    {discoveredProspects.length} People Found
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <button
                    type="button"
                    onClick={toggleSelectAllProspects}
                    className="text-primary hover:underline font-medium text-xs"
                  >
                    {selectedProspectIds.size === filteredProspects.length ? "Deselect All" : "Select All"} ({selectedProspectIds.size} included)
                  </button>
                  {lastSearchSource && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground capitalize">
                        Engine: {lastSearchSource.replaceAll("_", " ")}
                      </span>
                    </>
                  )}
                </div>

                {/* Match Filter Pills */}
                <div className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMatchPriorityFilter("all")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                      matchPriorityFilter === "all"
                        ? "bg-primary text-primary-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-ink"
                    }`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setMatchPriorityFilter("strong")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                      matchPriorityFilter === "strong"
                        ? "bg-primary text-primary-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-ink"
                    }`}
                  >
                    Strong (60%+)
                  </button>
                  <button
                    type="button"
                    onClick={() => setMatchPriorityFilter("high")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                      matchPriorityFilter === "high"
                        ? "bg-primary text-primary-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-ink"
                    }`}
                  >
                    High (80%+)
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredProspects.map((prospect) => {
                  const isSelected = selectedProspectIds.has(prospect.id);
                  const enrichment = (prospect.enrichment || {}) as Record<string, unknown>;
                  const avatarUrl = (enrichment.avatarUrl as string) || null;
                  const score = typeof enrichment.effectivenessScore === "number" ? enrichment.effectivenessScore : null;
                  const reasons = (enrichment.scoreReasons as string[]) || [];
                  const matchReason = (enrichment.matchReason as string) || reasons[0] || null;
                  const summary = (enrichment.summary as string) || (enrichment.headline as string) || null;
                  const news = (enrichment.newsContext as string) || (enrichment.recentNews as string) || null;
                  const signals = Array.isArray(enrichment.signals) ? (enrichment.signals as string[]) : [];
                  const education = (enrichment.education as string) || (enrichment.almaMater as string) || null;

                  return (
                    <div
                      key={prospect.id}
                      onClick={() => toggleProspectSelection(prospect.id)}
                      className={`flex flex-col justify-between rounded-2xl border p-4 text-xs shadow-2xs hover:border-border transition-all gap-3 cursor-pointer ${
                        isSelected
                          ? "border-primary bg-primary/[0.02] ring-1 ring-primary"
                          : "border-border/60 bg-card opacity-70 hover:opacity-100"
                      }`}
                    >
                      <div className="space-y-2.5">
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            aria-label={`Include ${prospect.fullName}`}
                            className="mt-1 h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary shrink-0"
                          />
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
                        {(matchReason || signals.length > 0 || education) && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {matchReason && (
                              <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary">
                                {matchReason}
                              </span>
                            )}
                            {education && (
                              <span className="rounded-full border border-indigo-500/25 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300 inline-flex items-center gap-1">
                                <GraduationCap className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">{education}</span>
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
                      <div className="flex items-center justify-between pt-2 border-t border-border/40 text-[11px] text-muted-foreground" onClick={(e) => e.stopPropagation()}>
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
              Next: Draft Message ({selectedProspectIds.size})
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

            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <Label htmlFor="seed" className="text-xs font-medium text-ink">
                  Template Outline / Starter Prompts
                </Label>
                <div className="flex flex-wrap gap-1.5">
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

              {/* Variable Tokens Toolbar */}
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-[11px] text-muted-foreground mr-1">Insert tokens:</span>
                {[
                  { token: "{{name}}", label: "First Name" },
                  { token: "{{company}}", label: "Company" },
                  { token: "{{title}}", label: "Job Title" },
                  { token: "{{newsContext}}", label: "News Catalyst" },
                  { token: "{{matchReason}}", label: "Match Reason" },
                ].map((v) => (
                  <button
                    key={v.token}
                    type="button"
                    onClick={() => insertVariable(v.token)}
                    className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-mono text-ink/80 hover:bg-muted hover:text-ink transition"
                    title={`Insert ${v.token}`}
                  >
                    +{v.token}
                  </button>
                ))}
              </div>
            </div>

            {/* Live AI Personalization Preview */}
            <div className="rounded-2xl border border-primary/20 bg-primary/[0.03] p-4 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  Live Draft Personalization Preview
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Simulated for {discoveredProspects[0] ? discoveredProspects[0].fullName : "First candidate"}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Subject: <span className="font-medium text-ink">Quick question about {discoveredProspects[0]?.company || "team"} engineering, {discoveredProspects[0] ? discoveredProspects[0].fullName.split(" ")[0] : "there"}</span>
              </p>
              <div className="rounded-xl border border-border/60 bg-card p-3 text-[11.5px] text-ink leading-relaxed font-sans space-y-1.5">
                <p>
                  Hi <span className="rounded-md bg-primary/10 text-primary px-1.5 py-0.2 font-medium">{discoveredProspects[0] ? discoveredProspects[0].fullName.split(" ")[0] : "Sarah"}</span>,
                </p>
                <p>
                  I saw your work as <span className="rounded-md bg-primary/10 text-primary px-1.5 py-0.2 font-medium">{discoveredProspects[0]?.title || "VP of Engineering"}</span> at <span className="rounded-md bg-primary/10 text-primary px-1.5 py-0.2 font-medium">{discoveredProspects[0]?.company || "Capital One"}</span>
                  {Boolean((discoveredProspects[0]?.enrichment as any)?.newsContext) ? (
                    <> (congratulations on the recent <span className="rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.2 font-medium">{(discoveredProspects[0]?.enrichment as any).newsContext}</span>!)</>
                  ) : (
                    <> and have been closely following the team&apos;s developments.</>
                  )}
                </p>
                <p>
                  {messageIntent.trim() || "If your schedule permits, I'd love to ask 2-3 brief questions about your team culture over a quick 15-minute coffee chat."}
                </p>
              </div>
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
