"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { toast } from "@/lib/toast";
import { saveAiSettings } from "@/actions/settings";
import { AI_PROVIDERS, type AiProvider } from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { integrationHref } from "@/components/settings/sections";
import { useLifetimeIncludesAi } from "@/components/lifetime-ai-offer";
import { PROVIDER_BRAND, ProviderLogo } from "@/components/onboarding/provider-logo";

/**
 * Onboarding's "add your AI key" step. AI is bring-your-own-key on every plan, and Capture
 * and Chat are the first things a new user tries, so without a key here the tour's Capture
 * stop would open on a notice instead of an extraction. Deliberately skippable: imports,
 * contacts and reminders need no key at all.
 *
 * The key is checked with the provider as it saves (`saveAiSettings` → `checkAiKey`): a
 * rejected or malformed key comes back as `{ok:false}` and is toasted; a check that timed
 * out saves the key with a note.
 */
export function AiKeyStep({ onSaved, onSkip }: { onSaved: () => void; onSkip: () => void }) {
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [pending, start] = useTransition();
  const meta = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const lifetimeIncludesAi = useLifetimeIncludesAi();

  function save() {
    const key = apiKey.trim();
    if (!key) return;
    start(async () => {
      try {
        const res = await saveAiSettings({ provider, apiKey: key });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.keyNote ?? `${meta.label} key saved`);
        onSaved();
      } catch (err) {
        toast.error(friendlyError(err, "That key didn’t save — try again?"));
      }
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Orbit’s AI runs on a key you own. You pay your provider directly, at cost, and nothing
        is marked up or shared. Pick a provider, create a key, and paste it here.
        {lifetimeIncludesAi && (
          <>
            {" "}With{" "}
            <Link href="/pricing" className="font-medium text-primary underline-offset-2 hover:underline">
              Orbit Lifetime
            </Link>
            , AI is included and no key is needed.
          </>
        )}
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        {AI_PROVIDERS.map((p) => {
          const selected = provider === p.id;
          const { brand, brandDark } = PROVIDER_BRAND[p.id];
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setProvider(p.id)}
              aria-pressed={selected}
              style={{ "--brand": brand, "--brand-dark": brandDark } as React.CSSProperties}
              className={cn(
                // Each provider in its own colour; selection is the same colour's border
                // and a faint wash of it, so the three still read as one control.
                "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition-[border-color,background-color,opacity]",
                "text-[var(--brand)] dark:text-[var(--brand-dark)]",
                selected
                  ? "border-[var(--brand)] bg-[color-mix(in_oklab,var(--brand)_8%,transparent)] dark:border-[var(--brand-dark)] dark:bg-[color-mix(in_oklab,var(--brand-dark)_12%,transparent)]"
                  : "border-border/70 opacity-75 hover:border-border hover:opacity-100",
              )}
            >
              <ProviderLogo provider={p.id} />
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-sm">
        <a
          href={meta.keyPageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
        >
          {meta.keyPageLabel}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        {provider === "gemini" && (
          <p className="text-muted-foreground">Google’s free tier covers a normal week of use.</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="onboarding-ai-key">{meta.label} key</Label>
        <Input
          id="onboarding-ai-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={meta.keyPlaceholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Checked with {meta.label} when you save, then stored encrypted with your account.
        </p>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={save} disabled={pending || !apiKey.trim()}>
            {pending ? "Saving…" : "Save and continue"}
          </Button>
          <Button type="button" variant="ghost" onClick={onSkip} disabled={pending}>
            Skip for now
          </Button>
          <Link
            href={integrationHref("ai")}
            className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            More options in Settings
          </Link>
        </div>
      </div>
    </div>
  );
}
