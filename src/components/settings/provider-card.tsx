"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AnthropicMark,
  GeminiMark,
  OpenAiMark,
} from "@/components/settings/provider-marks";
import { PROVIDER_MODELS, tieredModels, type AiProvider, type ModelTier } from "@/lib/ai-providers";
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
 * What `onSave` answers when the save THREW rather than being refused. It already toasted,
 * and settings were deliberately not refreshed, so there is nothing to show under the field
 * — but it is not success either, and returning the same `null` as success made this card
 * wipe the key the user had just pasted and collapse the Replace field on every thrown save.
 */
export const SAVE_THREW = Symbol("provider-card:save-threw");

/**
 * One provider: its mark, its name, a state line, and then the model choice, a place to
 * paste or replace a key, and Clear.
 *
 * Exactly one provider is active at a time — that is what `aiProvider` means — so `active`
 * is true on at most one card, and picking a model on another card switches to it, because
 * `saveAiSettings` writes the provider alongside the model.
 *
 * The tiers come from `tieredModels`, however many there are: a provider may declare two.
 * Gemini does, because it has nothing honest to put in the top slot.
 *
 * The chooser is shown whenever the provider is USABLE — a personal key, or Orbit's own key
 * (`managedAvailable`, which a dev server on `.env.local` also has). Gating it on a personal
 * key alone would take the model choice away from every managed account, and the chosen
 * model is not cosmetic there: `managedModel()` returns the requested id while managed AI is
 * off, so it is what actually runs.
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
  /** Resolves to a refusal to show under the key field, null when it went through, or
   *  `SAVE_THREW` when it blew up and has already been toasted. */
  onSave: (input: {
    provider: AiProvider;
    model?: string;
    apiKey?: string;
  }) => Promise<string | null | typeof SAVE_THREW>;
  onClear: (provider: AiProvider) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  /** Rotating a saved key in place. Clearing first would be the destructive route: a clear
   *  can drop this account's embeddings, so key hygiene must not go through it. */
  const [replacing, setReplacing] = useState(false);
  const [pending, start] = useTransition();
  const tierRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const Mark = MARKS[provider.id];
  const tiers = tieredModels(provider.id);
  const keyFieldId = `provider-key-${provider.id}`;
  const keyErrorId = `provider-key-error-${provider.id}`;

  const hasKey = Boolean(status?.hasPersonalKey);
  const usable = hasKey || Boolean(status?.managedAvailable);
  const showKeyField = !hasKey || replacing;
  const chosenIndex = tiers.findIndex((m) => active && model === m.value);

  const base = hasKey
    ? active
      ? "Your key is saved, and Orbit is using it"
      : "Your key is saved"
    : status?.managedAvailable
      ? "No key saved — AI is already covered for you"
      : "No key yet — paste one to turn on AI features";
  /**
   * An active account can sit on an id no tier button carries — an untagged preset, a custom
   * id, or one this branch dropped from the presets — and then every button reads unselected
   * with nothing on screen saying what is actually running. Say it.
   */
  const stateLine =
    active && model && chosenIndex === -1
      ? `${base} · Running ${PROVIDER_MODELS[provider.id].find((m) => m.value === model)?.label ?? model}`
      : base;

  /**
   * Arrows move focus without choosing. A radio group may do that where selection on focus
   * would fire something costly, and here each choice is a save round-trip; Space or Enter
   * on the focused button chooses, which a `<button>` already does.
   */
  function onTierKeyDown(event: React.KeyboardEvent, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    tierRefs.current[(index + step + tiers.length) % tiers.length]?.focus();
  }

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

      {usable ? (
        <div
          role="radiogroup"
          aria-label={`${provider.label} model`}
          className="flex flex-wrap gap-2"
        >
          {tiers.map((m, index) => {
            const chosen = active && model === m.value;
            return (
              <button
                key={m.value}
                ref={(node) => {
                  tierRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={chosen}
                // Roving tabindex: the group is one tab stop, landing on the chosen tier —
                // or the first, when nothing here is chosen yet.
                tabIndex={index === (chosenIndex === -1 ? 0 : chosenIndex) ? 0 : -1}
                disabled={pending}
                onKeyDown={(event) => onTierKeyDown(event, index)}
                onClick={() =>
                  start(async () => {
                    await onSave({ provider: provider.id, model: m.value });
                  })
                }
                className={cn(
                  "min-h-11 flex-1 basis-32 rounded-lg border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-60",
                  chosen ? "border-primary bg-primary/10" : "border-border/60 hover:bg-card/60"
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
      ) : null}

      {showKeyField ? (
        <div className="space-y-1.5">
          <Label htmlFor={keyFieldId} className="text-xs text-muted-foreground">
            {hasKey ? `New ${provider.label} API key` : `${provider.label} API key`}
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
                  // Straight to `saveAiSettings`, which overwrites the stored key. Never via
                  // `clearApiKey` — that can reset this account's embeddings.
                  const result = await onSave({
                    provider: provider.id,
                    apiKey: apiKey.trim(),
                  });
                  // A throw is neither a refusal to show nor a save: leave the pasted key and
                  // the open field alone, and let the toast be the only word on it.
                  if (result === SAVE_THREW) return;
                  setKeyError(result);
                  if (!result) {
                    setApiKey("");
                    setReplacing(false);
                  }
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
      ) : null}

      {hasKey ? (
        <div className="mt-auto flex flex-wrap gap-2">
          {replacing ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setReplacing(false);
                setApiKey("");
                setKeyError(null);
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              aria-describedby={`provider-card-name-${provider.id}`}
              onClick={() => setReplacing(true)}
            >
              Replace key
            </Button>
          )}
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
      ) : null}
    </li>
  );
}
