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
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { channelLabel } from "@/lib/outreach-channels";
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
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

const STEPS = ["Audience", "Prospects", "Message", "Review"] as const;

/** Stored tone → Title-cased word. The stored values never change. */
function labelForTone(tone: string) {
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}

const CTA_ITEMS = OUTREACH_REPLY_CTAS.map((c) => ({ value: c, label: REPLY_CTA_LABELS[c] }));
const TONE_ITEMS = OUTREACH_TONES.map((t) => ({ value: t, label: labelForTone(t) }));
const CHANNEL_ITEMS = OUTREACH_CHANNELS.map((c) => ({ value: c, label: channelLabel(c) }));

function ReplyCtaSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: OutreachReplyCta;
  onChange: (next: OutreachReplyCta) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange((v ?? "book_intro") as OutreachReplyCta)}
      items={CTA_ITEMS}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CTA_ITEMS.map((cta) => (
          <SelectItem key={cta.value} value={cta.value}>
            {cta.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
          toast.success("Campaign created — check the filters before you search");
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
        toast.error(friendlyError(err, "That search didn’t work — try again?"));
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
        toast.success("Drafts ready — read them before you send");
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
                  className={cn(
                    "truncate text-xs font-medium",
                    isCurrent
                      ? "text-primary"
                      : isDone
                        ? "text-foreground"
                        : "text-muted-foreground"
                  )}
                >
                  {i + 1}. {label}
                </span>
                {/* Hidden on phones: four steps share 370px there, and the figure cost each
                    label enough to truncate it ("1. Audien…"). The bar below says the same
                    thing, and carries the value for assistive tech. */}
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
                  className={cn(
                    "h-full rounded-full transition-[width] duration-slow ease-house",
                    isCurrent || isDone ? "bg-primary" : "bg-muted-foreground/30"
                  )}
                  style={{ width: `${Math.round(value * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {step === 0 && (
        <Card size="lg">
          <CardContent className="space-y-4">
            <FormField label="Campaign name" id="campaign-name">
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 fintech founders outreach"
              />
            </FormField>
            <FormField
              label="Who do you want to reach?"
              id="audience"
              required
              hint="Name the company explicitly — tighter ICPs usually earn higher reply rates."
            >
              <Textarea
                id="audience"
                value={audienceQuery}
                onChange={(e) => setAudienceQuery(e.target.value)}
                rows={4}
                placeholder="Capital One recruiters for SWE or PM internship roles"
              />
            </FormField>
            <FormField label="Desired reply" id="reply-cta">
              <ReplyCtaSelect id="reply-cta" value={replyCta} onChange={setReplyCta} />
            </FormField>
            <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-inset p-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="enable-sequence"
                  checked={enableSequence}
                  onCheckedChange={(checked) => setEnableSequence(Boolean(checked))}
                />
                <Label htmlFor="enable-sequence" className="text-sm font-normal">
                  Enable follow-up sequence (improves reply rate)
                </Label>
              </div>
              {enableSequence && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {sequenceSteps.map((s, index) => (
                    <FormField key={index} label={`Follow-up ${index + 1} delay (days)`}>
                      {(id) => (
                        <Input
                          id={id}
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
                      )}
                    </FormField>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button onClick={handleAudienceNext} disabled={pending || !audienceQuery.trim()}>
                {pending ? "Saving…" : "Continue"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <Card size="lg">
          <CardContent className="space-y-4">
            <AudienceFiltersEditor
              filters={filters}
              onChange={setFilters}
              showDemoWarning={hasApollo === false}
            />
            {searchTotal !== null && (
              <p className="text-sm text-muted-foreground">
                Last search total: {searchTotal}
                {lastSearchSource ? ` (${lastSearchSource === "demo" ? "demo" : "Apollo"})` : ""}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep(0)} disabled={pending}>
                Back
              </Button>
              <Button onClick={handleSearch} disabled={pending}>
                {pending ? "Searching…" : "Search prospects"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card size="lg">
          <CardContent className="space-y-4">
            {lastSearchSource === "demo" && (
              <div className={cn("rounded-lg border px-3 py-2 text-xs", TONE.warning.box, TONE.warning.text)}>
                Drafts will use demo prospects. Add an Apollo key in Settings for live people.
              </div>
            )}
            <FormField
              label="Message intent"
              id="intent"
              required
              hint="This drives the draft — say if you are job-seeking, not selling a product."
            >
              <Textarea
                id="intent"
                value={messageIntent}
                onChange={(e) => setMessageIntent(e.target.value)}
                rows={3}
                placeholder="Ask Capital One recruiters about SWE/PM internship hiring and the best next step"
              />
            </FormField>
            <FormField label="Desired reply / CTA" id="reply-cta-2">
              <ReplyCtaSelect id="reply-cta-2" value={replyCta} onChange={setReplyCta} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Tone" id="tone">
                <Select value={tone} onValueChange={(v) => setTone(String(v ?? "professional"))} items={TONE_ITEMS}>
                  <SelectTrigger id="tone" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TONE_ITEMS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Default channel" id="channel">
                <Select
                  value={channel}
                  onValueChange={(v) => setChannel((v ?? "email") as OutreachChannel)}
                  items={CHANNEL_ITEMS}
                >
                  <SelectTrigger id="channel" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNEL_ITEMS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField label="Template seed" id="seed" optional>
              <Textarea
                id="seed"
                value={templateSeed}
                onChange={(e) => setTemplateSeed(e.target.value)}
                rows={3}
                placeholder="Hi {{name}}, I’m reaching out about internship recruiting…"
              />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep(1)} disabled={pending}>
                Back
              </Button>
              <Button onClick={handleMessageNext} disabled={pending || !messageIntent.trim()}>
                {pending ? "Generating…" : "Generate drafts & open campaign"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
