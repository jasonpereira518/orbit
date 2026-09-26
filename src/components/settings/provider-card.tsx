"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AnthropicMark,
  GeminiMark,
  OpenAiMark,
} from "@/components/settings/provider-marks";
import { tieredModels, type AiProvider, type ModelTier } from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

/** What the three tiers are called on screen. The model's own name is the small print. */
const TIER_LABELS: Record<ModelTier, string> = {
  cheapest: "Cheapest",
  balanced: "Balanced",
  best: "Most accurate",
};

/**
 * Decorative — the provider's name sits beside the mark either way. Partial on purpose:
 * OpenRouter has no card, because it is not selectable.
 */
const MARKS: Partial<Record<AiProvider, (props: { className?: string }) => React.ReactElement>> = {
  gemini: GeminiMark,
  openai: OpenAiMark,
  anthropic: AnthropicMark,
};

export type ProviderCardStatus = {
  hasPersonalKey: boolean;
  managedAvailable: boolean;
};

/**
 * One provider: its mark, its name, a state line, and then either a place to paste a key or
 * the model choice plus Clear.
 *
 * Exactly one provider is active at a time — that is what `aiProvider` means — so `active`
 * is true on at most one card, and picking a model on another card switches to it, because
 * `saveAiSettings` writes the provider alongside the model.
 *
 * The tiers come from `tieredModels`, however many there are: a provider may declare two.
 * Gemini does, because it has nothing honest to put in the top slot.
 */
export function ProviderCard({
  provider,
  status,
  active,
  model,
  onSave,
  onClear,
}: {
  provider: { id: AiProvider; label: string; keyPlaceholder: string };
  /** This account's state for the provider, or undefined before settings arrive. */
  status?: ProviderCardStatus;
  active: boolean;
  /** The stored model, when this is the active provider — otherwise null, so no tier reads
   *  as chosen on a card that is not the one in use. */
  model: string | null;
  /** Resolves to a refusal to show under the key field, or null when it went through. */
  onSave: (input: {
    provider: AiProvider;
    model?: string;
    apiKey?: string;
  }) => Promise<string | null>;
  onClear: (provider: AiProvider) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const Mark = MARKS[provider.id];
  const tiers = tieredModels(provider.id);
  const keyFieldId = `provider-key-${provider.id}`;
  const keyErrorId = `provider-key-error-${provider.id}`;

  const stateLine = status?.hasPersonalKey
    ? active
      ? "Your key is saved, and Orbit is using it"
      : "Your key is saved"
    : status?.managedAvailable
      ? "No key saved — AI is already covered for you"
      : "No key yet — paste one to turn on AI features";

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        active ? "border-primary/60 bg-primary/5" : "border-border/60"
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70">
          {Mark ? <Mark className="size-4" /> : null}
        </span>
        <h4 id={`provider-card-name-${provider.id}`} className="text-sm font-medium text-ink">
          {provider.label}
        </h4>
        {active ? (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-ink">In use</span>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">{stateLine}</p>

      {status?.hasPersonalKey ? (
        <>
          <div
            role="radiogroup"
            aria-label={`${provider.label} model`}
            className="flex flex-wrap gap-2"
          >
            {tiers.map((m) => {
              const chosen = active && model === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await onSave({ provider: provider.id, model: m.value });
                    })
                  }
                  className={cn(
                    "min-h-11 flex-1 basis-32 rounded-lg border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-60",
                    chosen
                      ? "border-primary bg-primary/10"
                      : "border-border/60 hover:bg-card/60"
                  )}
                >
                  <span className="block text-sm font-medium text-ink">
                    {m.tier ? TIER_LABELS[m.tier] : m.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">{m.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              aria-describedby={`provider-card-name-${provider.id}`}
              onClick={() =>
                start(async () => {
                  await onClear(provider.id);
                })
              }
            >
              Clear key
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-auto space-y-1.5">
          <Label htmlFor={keyFieldId} className="text-xs text-muted-foreground">
            {provider.label} API key
          </Label>
          <div className="flex gap-2">
            <Input
              id={keyFieldId}
              type="password"
              placeholder={provider.keyPlaceholder}
              value={apiKey}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={keyError ? keyErrorId : undefined}
              onChange={(e) => {
                setApiKey(e.target.value);
                setKeyError(null);
              }}
            />
            <Button
              type="button"
              disabled={pending || !apiKey.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() =>
                start(async () => {
                  const error = await onSave({
                    provider: provider.id,
                    apiKey: apiKey.trim(),
                  });
                  setKeyError(error);
                  if (!error) setApiKey("");
                })
              }
            >
              Save
            </Button>
          </div>
          {keyError ? (
            <p id={keyErrorId} role="alert" className="text-sm text-destructive">
              {keyError}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
