"use client";

import { useMemo, useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BulkActionBar,
} from "@/components/outreach/bulk-action-bar";
import { AudienceFiltersEditor } from "@/components/outreach/audience-filters-editor";
import type { WarmPath } from "@/lib/warm-paths";
import { CampaignInsights } from "@/components/outreach/campaign-insights";
import { CampaignKpiStrip } from "@/components/outreach/campaign-kpi-strip";
import { PipelineFilters } from "@/components/outreach/pipeline-filters";
import {
  ProspectTable,
  useSelectedProspectIds,
  type ProspectRow,
} from "@/components/outreach/prospect-table";
import { Button } from "@/components/ui/button";
import {
  generateDueFollowUps,
  generateOutreachDrafts,
  getCampaignBackgroundStatusAction,
  searchProspects,
  triggerCampaignBackgroundSearchAction,
  updateCampaign,
} from "@/actions/outreach";
import { Activity, CheckCircle2, ChevronDown, ChevronUp, Download, Loader2, Sparkles, Terminal, X } from "lucide-react";
import { CampaignExportDialog } from "@/components/outreach/campaign-export-dialog";
import { toast } from "@/lib/toast";
import { isDeliveredMessage, prospectPipelineBucket } from "@/lib/outreach-metrics";
import type {
  AudienceFilters,
  CampaignMetrics,
  OutreachChannel,
  PipelineFilter,
  SequenceStep,
} from "@/lib/outreach-types";
import type { CampaignBackgroundJob } from "@/db/schema";
import { friendlyError } from "@/lib/errors";

export function CampaignWorkspace({
  campaign,
}: {
  campaign: {
    id: string;
    /** Normalised company key -> people the user already knows there; see `getCampaign`. */
    warmPaths?: Record<string, WarmPath[]>;
    name: string;
    audienceQuery: string | null;
    messageIntent: string | null;
    replyCta?: string | null;
    tone: string | null;
    defaultChannel: string | null;
    status: string;
    lastSearchSource?: string | null;
    backgroundJob?: CampaignBackgroundJob | null;
    audienceFilters?: AudienceFilters | null;
    sequenceSteps?: SequenceStep[] | null;
    metrics: CampaignMetrics;
    channelBreakdown: Array<{
      channel: string;
      sent: number;
      positiveReplies: number;
      successfulReplyRate: number | null;
    }>;
    stepBreakdown: Array<{
      stepIndex: number;
      label: string;
      sent: number;
      positiveReplies: number;
      successfulReplyRate: number | null;
    }>;
    prospects: Array<{
      id: string;
      fullName: string;
      title: string | null;
      company: string | null;
      email: string | null;
      phone: string | null;
      linkedinUrl: string | null;
      status: string;
      contactId: string | null;
      enrichment?: Record<string, unknown> | null;
      messages: Array<{
        id: string;
        channel: string;
        subject: string | null;
        body: string;
        status: string;
        stepIndex?: number | null;
        outcome?: string | null;
        scheduledFor?: Date | string | null;
        sentAt?: Date | string | null;
      }>;
    }>;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pipeline, setPipeline] = useState<PipelineFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | "high" | "strong">("all");
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<AudienceFilters>(
    (campaign.audienceFilters as AudienceFilters) || {}
  );
  const [bgJob, setBgJob] = useState<CampaignBackgroundJob | null>(campaign.backgroundJob || null);
  const [showDismissedBgAlert, setShowDismissedBgAlert] = useState(false);
  const [showActivityDrawer, setShowActivityDrawer] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Poll background job when active
  useEffect(() => {
    if (bgJob?.status !== "running") return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the callback is async by design; failures are handled inside it
    const interval = setInterval(async () => {
      try {
        const latest = await getCampaignBackgroundStatusAction(campaign.id);
        if (latest) {
          setBgJob(latest);
          if (latest.status === "completed") {
            toast.success(latest.message || "Background deep search completed!");
            router.refresh();
          } else if (latest.status === "failed") {
            toast.error(latest.message || "Background search encountered an issue");
          }
        }
      } catch {
        // Retry silently on next tick
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [bgJob?.status, campaign.id, router]);

  const defaultChannel = (campaign.defaultChannel || "email") as OutreachChannel;
  const isDemo =
    campaign.lastSearchSource === "demo" ||
    campaign.prospects.some((p) => Boolean(p.enrichment?.demo));

  const prospects: ProspectRow[] = campaign.prospects.map((p) => {
    const sorted = [...p.messages].sort((a, b) => {
      const aStep = a.stepIndex ?? 0;
      const bStep = b.stepIndex ?? 0;
      if (bStep !== aStep) return bStep - aStep;
      return 0;
    });
    const active =
      sorted.find(
        (m) =>
          m.status === "generated" ||
          m.status === "draft" ||
          m.status === "copied" ||
          m.status === "scheduled"
      ) ||
      sorted.find((m) => !m.outcome) ||
      sorted[0];

    return {
      id: p.id,
      fullName: p.fullName,
      title: p.title,
      company: p.company,
      email: p.email,
      phone: p.phone,
      linkedinUrl: p.linkedinUrl,
      status: p.status,
      contactId: p.contactId,
      isDemo: Boolean(p.enrichment?.demo),
      companyMismatch: Boolean(p.enrichment?.companyMismatch),
      avatarUrl: typeof (p.enrichment as Record<string, unknown> | null)?.avatarUrl === "string"
        ? ((p.enrichment as Record<string, unknown>).avatarUrl as string)
        : null,
      enrichment: p.enrichment,
      pipeline: prospectPipelineBucket({
        id: p.id,
        status: p.status,
        messages: p.messages.map((m) => ({
          id: m.id,
          status: m.status,
          outcome: m.outcome ?? null,
          stepIndex: m.stepIndex ?? 0,
          channel: m.channel,
          sentAt: m.sentAt ?? null,
          scheduledFor: m.scheduledFor ?? null,
        })),
      }),
      message: active
        ? {
            id: active.id,
            channel: active.channel as OutreachChannel,
            subject: active.subject,
            body: active.body,
            status: active.status,
            stepIndex: active.stepIndex ?? 0,
            outcome: active.outcome ?? null,
            scheduledFor: active.scheduledFor ?? null,
            sentAt: active.sentAt ?? null,
          }
        : null,
      messages: p.messages,
    };
  });

  const counts = useMemo(() => {
    const next: Partial<Record<PipelineFilter, number>> = { all: prospects.length };
    for (const prospect of prospects) {
      const bucket = prospect.pipeline || "all";
      next[bucket] = (next[bucket] || 0) + 1;
    }
    return next;
  }, [prospects]);

  const filtered = useMemo(() => {
    let result = pipeline === "all" ? prospects : prospects.filter((p) => p.pipeline === pipeline);
    if (priorityFilter === "high") {
      result = result.filter((p) => (p.enrichment as Record<string, unknown> | null)?.priorityTier === "high");
    } else if (priorityFilter === "strong") {
      result = result.filter(
        (p) => {
          const tier = (p.enrichment as Record<string, unknown> | null)?.priorityTier;
          return tier === "high" || tier === "strong";
        }
      );
    }
    // Sort highest effectiveness first
    return [...result].sort((a, b) => {
      const aScore = (typeof (a.enrichment as Record<string, unknown> | null)?.effectivenessScore === "number"
        ? (a.enrichment as Record<string, unknown>).effectivenessScore as number
        : 0);
      const bScore = (typeof (b.enrichment as Record<string, unknown> | null)?.effectivenessScore === "number"
        ? (b.enrichment as Record<string, unknown>).effectivenessScore as number
        : 0);
      return bScore - aScore;
    });
  }, [pipeline, priorityFilter, prospects]);

  const selectedIds = useSelectedProspectIds(filtered);

  const bulkRows = filtered
    .filter((p) => p.message && !isDeliveredMessage({ ...p.message, outcome: p.message.outcome ?? null }))
    .map((p) => ({
      prospectId: p.id,
      prospectName: p.fullName,
      messageId: p.message!.id,
      channel: p.message!.channel,
      subject: p.message!.subject,
      body: p.message!.body,
      email: p.email,
      phone: p.phone,
      linkedinUrl: p.linkedinUrl,
    }));

  function refresh() {
    router.refresh();
  }

  function rerunSearch() {
    start(async () => {
      try {
        await updateCampaign(campaign.id, {
          audienceFilters: filters,
          reparseAudience: false,
        });
        const res = await searchProspects(campaign.id);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const result = res.value;
        if (result.source === "demo") {
          toast.success(
            `Demo search: ${result.matched} matched` +
              (result.mismatched ? `, ${result.mismatched} excluded` : "")
          );
        } else {
          toast.success(
            `Imported ${result.matched} matching prospects` +
              (result.mismatched ? ` (${result.mismatched} excluded)` : "")
          );
        }
        setShowFilters(false);
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, "That search didn’t work — try again?"));
      }
    });
  }

  function regenerateSelected() {
    start(async () => {
      try {
        await generateOutreachDrafts({
          campaignId: campaign.id,
          prospectIds: selectedIds,
          channel: defaultChannel,
          excludeLowSignal: true,
        });
        toast.success("Drafts regenerated");
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t regenerate that draft — try again?"));
      }
    });
  }

  function generateFollowUps() {
    start(async () => {
      try {
        const result = await generateDueFollowUps(campaign.id);
        toast.success(
          result.generated
            ? `Generated ${result.generated} follow-up drafts`
            : "No follow-ups are due"
        );
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t write those follow-ups — try again?"));
      }
    });
  }

  function handleDeepSearch() {
    start(async () => {
      try {
        setBgJob({
          status: "running",
          phase: "news_scan",
          startedAt: new Date().toISOString(),
          message: "Starting deep search in background...",
        });
        setShowDismissedBgAlert(false);

        await triggerCampaignBackgroundSearchAction(campaign.id);
        toast.message("Scouting started in the background — you can continue working freely");
      } catch {
        setBgJob({
          status: "failed",
          message: "Could not start background search. Please try again.",
        });
        toast.error("Deep search encountered an issue — try again in a moment");
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Background Activity Banner */}
      {bgJob?.status === "running" && (
        <div className="relative overflow-hidden rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4 shadow-sm backdrop-blur-xs dark:bg-sky-500/10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-full bg-sky-500/20 text-sky-600 dark:text-sky-400">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-40" />
                <Loader2 className="h-4 w-4 animate-spin text-sky-600 dark:text-sky-300" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-sky-950 dark:text-sky-100">
                    Orbit Autonomous Scout Active
                  </span>
                  <span className="inline-flex items-center rounded-full bg-sky-500/15 px-2 py-0.5 text-3xs font-medium text-sky-700 dark:text-sky-300">
                    Background execution
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-sky-900/80 dark:text-sky-200/80">
                  {bgJob.message || "Scouting web news and matching candidates with BrightData..."}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => setShowActivityDrawer((v) => !v)}
                className="rounded-full gap-1.5 text-xs border-sky-500/30 bg-card/80 hover:bg-card"
              >
                <Activity className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                {showActivityDrawer ? "Hide Scout Stream" : "Live Agent Stream"}
                {showActivityDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
            </div>
          </div>

          {/* Expandable Live Agent Activity Drawer */}
          {showActivityDrawer && (
            <div className="mt-3.5 space-y-2 rounded-xl border border-sky-500/20 bg-card/70 p-3.5 text-xs backdrop-blur-xs">
              <div className="flex items-center justify-between border-b border-border/50 pb-2 text-2xs font-semibold text-sky-950 dark:text-sky-100">
                <span className="flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                  Live Scout Execution Log
                </span>
                <span className="text-muted-foreground font-normal">
                  Phase: {bgJob.phase || "scanning"}
                </span>
              </div>

              <div className="space-y-2 pt-1 font-mono text-2xs">
                <div className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold">✓</span>
                  <span className="text-muted-foreground">
                    Target Criteria: Searching {campaign.name} for matching leadership & decision-makers.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={bgJob.phase === "news_scan" ? "animate-pulse text-sky-500 font-bold" : "text-emerald-500 font-bold"}>
                    {bgJob.phase === "news_scan" ? "●" : "✓"}
                  </span>
                  <span className="text-ink">
                    Web Catalysts: Scanning recent press, company growth indicators, and news articles via BrightData.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={bgJob.phase === "people_discovery" ? "animate-pulse text-sky-500 font-bold" : bgJob.phase === "drafting" || bgJob.phase === "completed" ? "text-emerald-500 font-bold" : "text-muted-foreground"}>
                    {bgJob.phase === "people_discovery" ? "●" : bgJob.phase === "drafting" || bgJob.phase === "completed" ? "✓" : "○"}
                  </span>
                  <span className="text-ink">
                    Prospect Discovery: Unlocking candidate profiles & calculating effectiveness scores.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={bgJob.phase === "drafting" ? "animate-pulse text-sky-500 font-bold" : bgJob.phase === "completed" ? "text-emerald-500 font-bold" : "text-muted-foreground"}>
                    {bgJob.phase === "drafting" ? "●" : bgJob.phase === "completed" ? "✓" : "○"}
                  </span>
                  <span className="text-ink">
                    Tailored Drafts: Formulating news-referenced email & LinkedIn intros.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Completed Background Job Banner */}
      {bgJob?.status === "completed" && !showDismissedBgAlert && bgJob.prospectsAdded !== undefined && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-950 dark:text-emerald-100">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>
                <strong>Background scout completed:</strong> {bgJob.message}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setShowActivityDrawer((v) => !v)}
                className="rounded-full gap-1 text-2xs h-6 px-2 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-500/20"
              >
                <Activity className="h-3 w-3" />
                {showActivityDrawer ? "Hide Stream" : "View Scout Log"}
              </Button>
              <button
                type="button"
                aria-label="Dismiss alert"
                onClick={() => setShowDismissedBgAlert(true)}
                className="rounded-full p-1 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Expandable Activity Drawer for completed job */}
          {showActivityDrawer && (
            <div className="mt-3 space-y-1.5 rounded-xl border border-emerald-500/20 bg-card/70 p-3 text-xs text-foreground backdrop-blur-xs font-mono text-2xs">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Autonomous scout run finished successfully
              </div>
              <div className="text-muted-foreground pt-1">
                • {bgJob.prospectsAdded} prospects discovered & added to campaign pipeline.
              </div>
              <div className="text-muted-foreground">
                • Catalysts and tailored personal messages ready for 1-click review.
              </div>
              {bgJob.completedAt && (
                <div className="text-3xs text-muted-foreground pt-1">
                  Completed at {new Date(bgJob.completedAt).toLocaleTimeString()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isDemo && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-100">
          <strong>Preview mode.</strong> Showing high-fidelity sample profiles. Enable live scraping with BrightData in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings
          </Link>{" "}
          for live web scraping.
        </div>
      )}

      <CampaignKpiStrip metrics={campaign.metrics} />

      <CampaignInsights
        channelBreakdown={campaign.channelBreakdown}
        stepBreakdown={campaign.stepBreakdown}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
            disabled={pending}
            className="rounded-full text-xs"
          >
            {showFilters ? "Hide filters" : "Edit filters & re-run search"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={regenerateSelected}
            disabled={pending || !selectedIds.length}
            className="rounded-full text-xs"
          >
            Regenerate selected drafts
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={generateFollowUps}
            disabled={pending}
            className="rounded-full text-xs"
          >
            Generate due follow-ups
            {campaign.metrics.pendingFollowUpCount
              ? ` (${campaign.metrics.pendingFollowUpCount})`
              : ""}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExportOpen(true)}
            className="gap-1.5 shadow-xs rounded-full text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>

          <Button
            size="sm"
            onClick={handleDeepSearch}
            disabled={pending || bgJob?.status === "running"}
            className="gap-1.5 shadow-xs rounded-full text-xs"
          >
            {bgJob?.status === "running" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Scouting in Background...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Scout Web in Background
              </>
            )}
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="space-y-3">
          <AudienceFiltersEditor
            filters={filters}
            onChange={setFilters}
            showDemoWarning={isDemo}
          />
          <Button size="sm" onClick={rerunSearch} disabled={pending} className="rounded-full text-xs">
            Re-run search with these filters
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <PipelineFilters value={pipeline} counts={counts} onChange={setPipeline} />

        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card p-1 text-xs">
          <span className="px-2 text-muted-foreground font-medium text-2xs">Match:</span>
          <button
            type="button"
            onClick={() => setPriorityFilter("all")}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              priorityFilter === "all"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setPriorityFilter("strong")}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              priorityFilter === "strong"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Strong (60%+)
          </button>
          <button
            type="button"
            onClick={() => setPriorityFilter("high")}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              priorityFilter === "high"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            High (80%+)
          </button>
        </div>
      </div>

      <BulkActionBar
        campaignId={campaign.id}
        rows={bulkRows}
        selectedProspectIds={selectedIds}
        onUpdated={refresh}
      />

      <ProspectTable
        campaignId={campaign.id}
        prospects={filtered}
        warmPaths={campaign.warmPaths}
        defaultChannel={defaultChannel}
        onUpdated={refresh}
      />

      <CampaignExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        campaignName={campaign.name}
        prospects={filtered}
      />
    </div>
  );
}
