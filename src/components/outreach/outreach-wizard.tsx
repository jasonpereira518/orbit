"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  createCampaign,
  generateOutreachDrafts,
  getOutreachApolloStatus,
  searchProspects,
  updateCampaign,
} from "@/actions/outreach";
import { AudienceFiltersEditor } from "@/components/outreach/audience-filters-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

const STEPS = ["Audience", "Prospects", "Message", "Review"] as const;

export function OutreachWizard({ campaignId: initialCampaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState(initialCampaignId || "");
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
  const [lastSearchSource, setLastSearchSource] = useState<"demo" | "apollo" | null>(
    null
  );
  const [pending, start] = useTransition();

  useEffect(() => {
    getOutreachApolloStatus()
      .then((s) => setHasApollo(s.hasApollo))
      .catch(() => setHasApollo(false));
  }, []);

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
          setStep(1);
          toast.success("Campaign created — confirm filters before searching");
        } else {
          const updated = await updateCampaign(campaignId, {
            name,
            audienceQuery,
            replyCta,
            sequenceSteps: enableSequence ? sequenceSteps : [],
          });
          setFilters((updated.audienceFilters as AudienceFilters) || {});
          setStep(1);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save audience");
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
        const result = await searchProspects(campaignId);
        setSearchTotal(result.total);
        setLastSearchSource(result.source);
        if (result.source === "demo") {
          toast.success(
            `Demo search: ${result.matched} matched` +
              (result.mismatched ? `, ${result.mismatched} excluded` : "")
          );
        } else {
          toast.success(
            `Found ${result.matched} matching prospects` +
              (result.mismatched ? ` (${result.mismatched} excluded for company mismatch)` : "")
          );
        }
        setStep(2);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Search failed");
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
        toast.success("Drafts generated — review before sending");
        goToCampaign(campaignId);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Draft generation failed");
      }
    });
  }

  const stepProgress = STEPS.map((_, i) => {
    if (i < step) return 1;
    if (i > step) return 0;
    if (i === 0) {
      const filled =
        (name.trim() ? 0.25 : 0) +
        (audienceQuery.trim() ? 0.5 : 0) +
        (replyCta ? 0.25 : 0);
      return Math.min(1, Math.max(0.08, filled));
    }
    if (i === 1) {
      return searchTotal !== null ? 1 : pending ? 0.55 : 0.15;
    }
    if (i === 2) {
      const filled =
        (messageIntent.trim() ? 0.55 : 0) +
        (tone ? 0.2 : 0) +
        (channel ? 0.15 : 0) +
        (templateSeed.trim() ? 0.1 : 0);
      return Math.min(1, Math.max(0.08, filled));
    }
    return pending ? 0.45 : 0.08;
  });

  return (
    <div className="space-y-6">
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
                  className={`truncate text-xs font-medium ${
                    isCurrent
                      ? "text-primary"
                      : isDone
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  {i + 1}. {label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
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
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                    isCurrent || isDone ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
                  style={{ width: `${Math.round(value * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {step === 0 && (
        <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          <div className="space-y-1.5">
            <Label htmlFor="campaign-name">Campaign name</Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q3 fintech founders outreach"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audience">Who do you want to reach?</Label>
            <Textarea
              id="audience"
              value={audienceQuery}
              onChange={(e) => setAudienceQuery(e.target.value)}
              rows={4}
              placeholder="Capital One recruiters for SWE or PM internship roles"
            />
            <p className="text-xs text-muted-foreground">
              Name the company explicitly — tighter ICPs usually earn higher reply rates.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reply-cta">Desired reply</Label>
            <select
              id="reply-cta"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enableSequence}
                onChange={(e) => setEnableSequence(e.target.checked)}
              />
              Enable follow-up sequence (improves reply rate)
            </label>
            {enableSequence && (
              <div className="grid gap-3 sm:grid-cols-2">
                {sequenceSteps.map((s, index) => (
                  <div key={index} className="space-y-1.5">
                    <Label>Follow-up {index + 1} delay (days)</Label>
                    <Input
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
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <Button
            onClick={handleAudienceNext}
            disabled={pending || !audienceQuery.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Continue
          </Button>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          <AudienceFiltersEditor
            filters={filters}
            onChange={setFilters}
            showDemoWarning={hasApollo === false}
          />
          {searchTotal !== null && (
            <p className="text-sm text-muted-foreground">
              Last search total: {searchTotal}
              {lastSearchSource ? ` (${lastSearchSource})` : ""}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(0)} disabled={pending}>
              Back
            </Button>
            <Button
              onClick={handleSearch}
              disabled={pending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Search prospects
            </Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
          {lastSearchSource === "demo" && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              Drafts will use demo prospects. Add an Apollo key in Settings for live people.
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="intent">Message intent</Label>
            <Textarea
              id="intent"
              value={messageIntent}
              onChange={(e) => setMessageIntent(e.target.value)}
              rows={3}
              placeholder="Ask Capital One recruiters about SWE/PM internship hiring and the best next step"
            />
            <p className="text-xs text-muted-foreground">
              This drives the draft — say if you are job-seeking, not selling a product.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reply-cta-2">Desired reply / CTA</Label>
            <select
              id="reply-cta-2"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tone">Tone</Label>
              <select
                id="tone"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
              >
                {OUTREACH_TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="channel">Default channel</Label>
              <select
                id="channel"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={channel}
                onChange={(e) => setChannel(e.target.value as OutreachChannel)}
              >
                {OUTREACH_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seed">Template seed (optional)</Label>
            <Textarea
              id="seed"
              value={templateSeed}
              onChange={(e) => setTemplateSeed(e.target.value)}
              rows={3}
              placeholder="Hi {{name}}, I'm reaching out about internship recruiting..."
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(1)} disabled={pending}>
              Back
            </Button>
            <Button
              onClick={handleMessageNext}
              disabled={pending || !messageIntent.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Generate drafts & open campaign
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
