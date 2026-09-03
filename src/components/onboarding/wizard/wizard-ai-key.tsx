"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "@/lib/toast";
import { saveAiSettings } from "@/actions/settings";
import { AI_PROVIDERS, type AiProvider } from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The setup wizard's "connect your AI key" step, shown before the capture path when the
 * account has no provider key yet.
 *
 * Production is strictly bring-your-own-key, and the capture path is the first thing a new
 * user tries — so without this step the guided setup led straight into a hard error with a
 * link back to Settings. Deliberately skippable: importing or adding people by hand needs
 * no key at all.
 */
export function WizardAiKey({
  onSaved,
  onSkip,
}: {
  onSaved: () => void;
  onSkip: () => void;
}) {
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [pending, start] = useTransition();
  const meta = AI_PROVIDERS.find((p) => p.id === provider);

  function save() {
    const key = apiKey.trim();
    if (!key) return;
    start(async () => {
      try {
        await saveAiSettings({ provider, apiKey: key });
        toast.success(`${meta?.label ?? "AI"} key saved`);
        onSaved();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save the key");
      }
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Orbit reads your notes and answers questions about your network with an AI model
        that runs on your own key — at cost, never marked up, and never shared. You can
        change it any time under Settings.
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        {AI_PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProvider(p.id)}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-left text-sm transition-colors",
              provider === p.id
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <Label htmlFor="wizard-ai-key">{meta?.label ?? "API"} key</Label>
        <Input
          id="wizard-ai-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste your key"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Stored encrypted with your account. Keys are created in your provider&apos;s
          console; the free tiers cover a normal week of use.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={pending || !apiKey.trim()}>
          {pending ? "Saving…" : "Save and continue"}
        </Button>
        <Button type="button" variant="ghost" onClick={onSkip} disabled={pending}>
          Skip for now
        </Button>
        <Link
          href="/settings#settings-ai"
          className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          More options in Settings
        </Link>
      </div>
    </div>
  );
}
