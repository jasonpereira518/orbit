"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createCampaign } from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
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
import {
  OUTREACH_REPLY_CTAS,
  OUTREACH_TONES,
  REPLY_CTA_LABELS,
  type OutreachReplyCta,
} from "@/lib/outreach-types";
import { friendlyError } from "@/lib/errors";

type Channel = "email" | "linkedin";
type Tone = (typeof OUTREACH_TONES)[number];

const ASKS = OUTREACH_REPLY_CTAS.map((value) => ({ value, label: REPLY_CTA_LABELS[value] }));
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
];
const TONES = OUTREACH_TONES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

/**
 * One choice from a few, drawn as chips. Native radios under the styling, so the group is a
 * single tab stop, the arrow keys move the choice, and a screen reader hears "n of m".
 */
function ChipGroup<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-sm leading-none font-medium select-none">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label key={option.value} className="relative cursor-pointer">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="inline-flex min-h-9 items-center rounded-full border border-border/70 px-3.5 text-sm text-ink transition-colors hover:bg-muted/60 peer-checked:border-primary peer-checked:bg-primary/10 peer-checked:font-medium peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function NewCampaignForm() {
  const router = useRouter();
  const toneId = useId();
  const [audience, setAudience] = useState("");
  const [intent, setIntent] = useState("");
  const [ask, setAsk] = useState<OutreachReplyCta>("book_intro");
  const [channel, setChannel] = useState<Channel>("email");
  const [tone, setTone] = useState<Tone>("professional");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stays true after a successful create: the navigation takes a moment, and a second click in
  // that gap would make a second campaign.
  const [busy, setBusy] = useState(false);

  const ready = audience.trim().length >= 3 && intent.trim().length >= 3;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createCampaign({
        name: name.trim() || undefined,
        audienceQuery: audience.trim(),
        messageIntent: intent.trim(),
        replyCta: ask,
        defaultChannel: channel,
        tone,
      });
      if (!res.ok) {
        setError(res.error);
        setBusy(false);
        return;
      }
      router.push(`/outreach/${res.value.id}`);
    } catch (err) {
      setError(friendlyError(err, "Couldn’t create that campaign — try again?"));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6 rounded-2xl border border-border/70 bg-card p-6">
      <Field
        label="Who do you want to reach?"
        required
        description="A role, a school, a place — whatever describes them. This is what Orbit searches for."
      >
        <Textarea
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          required
          rows={3}
          maxLength={300}
          placeholder="UNC alumni doing health-economics consulting in RTP"
        />
      </Field>

      <Field
        label="Why are you reaching out?"
        required
        description="In your own words. Every draft is written from this."
      >
        <Textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          required
          rows={4}
          maxLength={1000}
          placeholder="I’m exploring health-economics consulting and would love to hear how they got into it"
        />
      </Field>

      <ChipGroup
        label="What are you asking for?"
        name="ask"
        value={ask}
        options={ASKS}
        onChange={setAsk}
      />

      <ChipGroup
        label="How will you reach them?"
        name="channel"
        value={channel}
        options={CHANNELS}
        onChange={setChannel}
      />

      <div className="space-y-1.5">
        <Label htmlFor={toneId}>Tone</Label>
        <Select
          value={tone}
          onValueChange={(v) => setTone((v ?? "professional") as Tone)}
          items={TONES}
        >
          <SelectTrigger id={toneId} className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} className="p-1">
            {TONES.map((item) => (
              <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <details>
        <summary className="w-fit cursor-pointer rounded-md text-sm text-muted-foreground outline-none select-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50">
          More
        </summary>
        <div className="pt-3">
          <Field
            label="Campaign name"
            description="Optional. Leave it blank to name it after who you’re reaching."
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoComplete="off"
            />
          </Field>
        </div>
      </details>

      <FormError>{error}</FormError>
      <Button
        type="submit"
        disabled={busy || !ready}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {busy ? "Creating…" : "Create campaign"}
      </Button>
    </form>
  );
}
