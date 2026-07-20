"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createCampaign,
  generateOutreachDrafts,
  searchProspects,
  updateCampaign,
} from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  OUTREACH_CHANNELS,
  OUTREACH_TONES,
  type OutreachChannel,
} from "@/lib/outreach-types";

const STEPS = ["Audience", "Prospects", "Message", "Review"] as const;

export function OutreachWizard({ campaignId: initialCampaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState(initialCampaignId || "");
  const [name, setName] = useState("");
  const [audienceQuery, setAudienceQuery] = useState("");
  const [messageIntent, setMessageIntent] = useState("");
  const [tone, setTone] = useState("professional");
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [templateSeed, setTemplateSeed] = useState("");
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [pending, start] = useTransition();

  function goToCampaign(id: string) {
    router.push(`/outreach/${id}`);
    router.refresh();
  }

  function handleAudienceNext() {
    start(async () => {
      try {
        if (!campaignId) {
          const campaign = await createCampaign({ name, audienceQuery });
          setCampaignId(campaign.id);
          setStep(1);
          toast.success("Campaign created");
        } else {
          await updateCampaign(campaignId, { name, audienceQuery });
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
        const result = await searchProspects(campaignId);
        setSearchTotal(result.total);
        toast.success(`Found ${result.imported} prospects`);
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
          tone,
          defaultChannel: channel,
        });
        await generateOutreachDrafts({
          campaignId,
          channel,
          templateSeed: templateSeed || undefined,
        });
        toast.success("Drafts generated");
        goToCampaign(campaignId);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Draft generation failed");
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`rounded-full px-3 py-1 text-xs ${
              i === step
                ? "bg-primary text-primary-foreground"
                : i < step
                  ? "bg-muted text-foreground"
                  : "bg-muted/50 text-muted-foreground"
            }`}
          >
            {i + 1}. {label}
          </div>
        ))}
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
              placeholder="Series A fintech founders in NYC who raised in the last 12 months"
            />
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
          <p className="text-sm text-muted-foreground">
            Search Apollo for people matching your audience. Without an Apollo key in
            Settings, demo prospects are used for testing.
          </p>
          {searchTotal !== null && (
            <p className="text-sm">Last search total: {searchTotal}</p>
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
          <div className="space-y-1.5">
            <Label htmlFor="intent">Message intent / CTA</Label>
            <Textarea
              id="intent"
              value={messageIntent}
              onChange={(e) => setMessageIntent(e.target.value)}
              rows={3}
              placeholder="Introduce my startup and ask for a 15-minute coffee chat"
            />
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
              placeholder="Hi {{name}}, I loved your work on..."
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
