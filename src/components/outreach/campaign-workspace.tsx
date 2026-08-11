"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BulkActionBar,
} from "@/components/outreach/bulk-action-bar";
import { AudienceFiltersEditor } from "@/components/outreach/audience-filters-editor";
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
  searchProspects,
  updateCampaign,
} from "@/actions/outreach";
import { toast } from "@/lib/toast";
import {
  prospectPipelineBucket,
} from "@/lib/outreach-metrics";
import type {
  AudienceFilters,
  CampaignMetrics,
  OutreachChannel,
  PipelineFilter,
  SequenceStep,
} from "@/lib/outreach-types";

export function CampaignWorkspace({
  campaign,
}: {
  campaign: {
    id: string;
    name: string;
    audienceQuery: string | null;
    messageIntent: string | null;
    replyCta?: string | null;
    tone: string | null;
    defaultChannel: string | null;
    status: string;
    lastSearchSource?: string | null;
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
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<AudienceFilters>(
    (campaign.audienceFilters as AudienceFilters) || {}
  );
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
    if (pipeline === "all") return prospects;
    return prospects.filter((p) => p.pipeline === pipeline);
  }, [pipeline, prospects]);

  const selectedIds = useSelectedProspectIds(filtered);

  const bulkRows = filtered
    .filter((p) => p.message && !p.message.outcome)
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
        const result = await searchProspects(campaign.id);
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
        toast.error(err instanceof Error ? err.message : "Search failed");
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
        toast.error(err instanceof Error ? err.message : "Regenerate failed");
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
            : "No due follow-ups"
        );
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Follow-up generation failed");
      }
    });
  }

  return (
    <div className="space-y-4">
      {isDemo && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
          <strong>Demo results.</strong> These prospects are fake placeholders, not live
          Apollo people. Add an Apollo API key in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings → Outreach
          </Link>{" "}
          and re-run search for real Capital One (or other) recruiters.
        </div>
      )}

      <CampaignKpiStrip metrics={campaign.metrics} />

      <CampaignInsights
        channelBreakdown={campaign.channelBreakdown}
        stepBreakdown={campaign.stepBreakdown}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters((v) => !v)}
          disabled={pending}
        >
          {showFilters ? "Hide filters" : "Edit filters & re-run search"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={regenerateSelected}
          disabled={pending || !selectedIds.length}
        >
          Regenerate selected drafts
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={generateFollowUps}
          disabled={pending}
        >
          Generate due follow-ups
          {campaign.metrics.pendingFollowUpCount
            ? ` (${campaign.metrics.pendingFollowUpCount})`
            : ""}
        </Button>
      </div>

      {showFilters && (
        <div className="space-y-3">
          <AudienceFiltersEditor
            filters={filters}
            onChange={setFilters}
            showDemoWarning={isDemo}
          />
          <Button size="sm" onClick={rerunSearch} disabled={pending}>
            Re-run search with these filters
          </Button>
        </div>
      )}

      <PipelineFilters value={pipeline} counts={counts} onChange={setPipeline} />

      <BulkActionBar
        campaignId={campaign.id}
        rows={bulkRows}
        selectedProspectIds={selectedIds}
        onUpdated={refresh}
      />

      <ProspectTable
        campaignId={campaign.id}
        prospects={filtered}
        defaultChannel={defaultChannel}
        onUpdated={refresh}
      />
    </div>
  );
}
