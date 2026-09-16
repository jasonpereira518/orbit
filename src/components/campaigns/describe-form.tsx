"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Mail, UserRound } from "lucide-react";
import { createCampaignAction } from "@/actions/outreach-campaigns";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import type { OutreachChannel } from "@/lib/outreach/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const CHANNELS: Array<{ value: OutreachChannel; label: string; hint: string; Icon: typeof Mail }> = [
  { value: "email", label: "Email", hint: "Sent from your own Gmail or Outlook", Icon: Mail },
  { value: "linkedin", label: "LinkedIn", hint: "Invitations sent by Orbit Runner in your browser", Icon: UserRound },
];

export function DescribeForm({ defaultIntro }: { defaultIntro: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [intro, setIntro] = useState(defaultIntro);
  const [saveIntro, setSaveIntro] = useState(!defaultIntro);
  const nameId = useId();
  const purposeId = useId();
  const outcomeId = useId();
  const notesId = useId();
  const introId = useId();
  const saveId = useId();
  const canSubmit = purpose.trim().length >= 10 && outcome.trim().length >= 3;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || pending) return;
    start(async () => {
      try {
        const result = await createCampaignAction({
          name,
          purpose,
          desiredOutcome: outcome,
          notes,
          channel,
          senderIntro: intro,
          saveIntroAsDefault: saveIntro,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        router.push(`/outreach/${result.value.id}/audience`);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t create the campaign"));
      }
    });
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        <div className="space-y-1.5">
          <Label htmlFor={purposeId}>What is this campaign for?</Label>
          <Textarea
            id={purposeId}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Meet partnership leads at Series A–C fintech startups in New York"
            rows={3}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={outcomeId}>What would a good outcome be?</Label>
          <Input
            id={outcomeId}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="Three intro calls before the end of the month"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={notesId}>Anything else Orbit should know (optional)</Label>
          <Textarea id={notesId} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Campaign name (optional)</Label>
          <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Taken from the purpose if left blank" />
        </div>
      </div>

      <fieldset className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
        <legend className="float-left mb-3 w-full text-sm font-medium text-ink">
          How will you reach people?
        </legend>
        <div className="grid clear-both gap-3 sm:grid-cols-2">
          {CHANNELS.map(({ value, label, hint, Icon }) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
                channel === value ? "border-primary bg-primary/5" : "border-border/70 hover:border-primary/40"
              )}
            >
              <input
                type="radio"
                name="channel"
                value={value}
                checked={channel === value}
                onChange={() => setChannel(value)}
                className="sr-only"
              />
              <Icon className="mt-0.5 size-4 text-primary" aria-hidden />
              <span>
                <span className="block text-sm font-medium text-ink">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
        <div className="space-y-1.5">
          <Label htmlFor={introId}>How you introduce yourself</Label>
          <Textarea
            id={introId}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            rows={3}
            placeholder="I’m a product lead at Orbit, and I write a small newsletter about fintech partnerships."
          />
          <p className="text-xs text-muted-foreground">Drafts use this so every message says who you are. You can edit it per campaign.</p>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id={saveId} checked={saveIntro} onCheckedChange={(checked) => setSaveIntro(Boolean(checked))} />
          <Label htmlFor={saveId} className="text-sm font-normal">
            Use this for future campaigns too
          </Label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit || pending}>
          {pending ? "Creating…" : "Continue to audience"}
        </Button>
      </div>
    </form>
  );
}
