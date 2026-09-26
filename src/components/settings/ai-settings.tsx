"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  clearApiKey,
  getSettings,
  saveAiSettings,
} from "@/actions/settings";
import {
  AI_PROVIDERS,
  SELECTABLE_AI_PROVIDERS,
  isSelectableAiProvider,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  type AiProvider,
} from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "@/components/settings/settings-section";
import { Disclosure } from "@/components/settings/disclosure";
import { ProviderCard } from "@/components/settings/provider-card";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import {
  AI_NOTICE_COPY,
  allowancePercentUsed,
  formatAllowanceReset,
} from "@/lib/ai-access-copy";
import { MANAGED_AI_ENABLED, managedModel } from "@/lib/managed-ai-policy";

type Settings = Awaited<ReturnType<typeof getSettings>>;

function modelLabel(provider: AiProvider, id: string) {
  return PROVIDER_MODELS[provider].find((m) => m.value === id)?.label ?? id;
}

/**
 * The AI page: one card per provider a person may choose, and everything technical folded
 * into Advanced.
 *
 * SELECTABLE_AI_PROVIDERS, not AI_PROVIDERS: the full table also carries providers whose
 * plumbing exists but which no surface offers (OpenRouter). `providerMeta` below still looks
 * up the full table, so an account already on one keeps its real name in the copy.
 */
export function AiSettings({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  // A router refresh (the plan changed — Lifetime bought or revoked) hands down fresh
  // settings; adopt them rather than keep describing the old plan.
  const [customModel, setCustomModel] = useState(initialSettings.aiModel);
  const [seenInitial, setSeenInitial] = useState(initialSettings);
  if (seenInitial !== initialSettings) {
    setSeenInitial(initialSettings);
    setSettings(initialSettings);
    // The custom-model field mirrors the stored id, so it has to adopt the fresh settings
    // too — otherwise it keeps showing the model this account was on before the refresh.
    setCustomModel(initialSettings.aiModel);
  }
  const [pending, start] = useTransition();

  const provider = settings.aiProvider;
  const model = settings.aiModel;
  /**
   * Set when a default changed under this account (`ai_model_migrated_from`). Shown once,
   * beside the model it moved to; saving anything clears it.
   */
  const movedFrom = settings.aiModelMigratedFrom;
  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const activeProviderStatus = settings.providers.find((p) => p.id === provider);
  const { ai } = settings;
  // Managed AI is off, and this is a dev server running on the keys in `.env.local`. The
  // same machinery as Lifetime's included AI, but it is the developer's own key, so it says
  // so rather than promising something no deployment does.
  const onLocalDevKeys = !MANAGED_AI_ENABLED && ai.eligibility === "demo" && ai.managedConfigured;
  // Lifetime, or a demo account that actually has a (local) managed key to run on.
  const onLifetime =
    ai.eligibility === "lifetime" || (ai.eligibility === "demo" && ai.managedConfigured);
  // What Orbit's key would run for the provider on screen, when it is the one paying.
  const managedRuns = activeProviderStatus?.managedAvailable
    ? managedModel(provider, model)
    : null;

  /**
   * One save path for every card and for the custom model field. `saveAiSettings` verifies a
   * new key and returns a refusal as DATA — a thrown Server Action message is an opaque
   * digest in production — so the refusal is handed back to the card that asked, and only an
   * unexpected throw becomes a toast.
   */
  async function save(input: {
    provider: AiProvider;
    model?: string;
    apiKey?: string;
  }): Promise<string | null> {
    try {
      const res = await saveAiSettings({
        provider: input.provider,
        // Saving a key on a provider that is not the active one moves the account to it, so
        // the stored model has to move too — otherwise it keeps the old provider's id.
        model:
          input.model ??
          (input.provider === settings.aiProvider ? undefined : DEFAULT_MODELS[input.provider]),
        apiKey: input.apiKey,
      });
      if (!res.ok) return res.error;
      const next = await getSettings();
      setSettings(next);
      setCustomModel(next.aiModel);
      toast.success(
        res.keyNote ??
          (res.embeddingReset
            ? "Saved — search will re-index for the new provider"
            : "AI settings saved")
      );
      return null;
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      return null;
    }
  }

  async function clearKey(target: AiProvider) {
    const label = AI_PROVIDERS.find((p) => p.id === target)?.label ?? target;
    try {
      const res = await clearApiKey(target);
      setSettings(await getSettings());
      toast.success(
        res.embeddingReset ? `${label} key cleared — search will re-index` : `${label} key cleared`
      );
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.saveFailed));
    }
  }

  return (
    <SettingsSection
      title="AI provider"
      description="Orbit uses AI to turn your notes into contacts and answer questions about your network. Pick a provider and paste its key — keys are encrypted at rest and only used for your account."
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {SELECTABLE_AI_PROVIDERS.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            status={settings.providers.find((s) => s.id === p.id)}
            active={p.id === provider}
            model={p.id === provider ? model : null}
            onSave={save}
            onClear={clearKey}
          />
        ))}
      </ul>

      <Disclosure label="Advanced">
        <p className="text-sm text-muted-foreground">
          {onLocalDevKeys
            ? "This dev server runs AI on the keys in your .env.local — nothing to set up. Save a key above and it is used instead, which is also how you see what a deployed account sees. Keys are encrypted at rest and only used for your account."
            : onLifetime
              ? "Orbit Lifetime includes AI on Orbit’s own keys — nothing to set up. You can still bring your own Gemini, OpenAI, or Anthropic key: whenever one is saved, Orbit uses yours instead. Keys are encrypted at rest and only used for your account."
              : `Choose Gemini, OpenAI, or Anthropic above and paste your own API key. Keys are encrypted at rest and only used for your account.${ai.managedConfigured ? " Orbit Lifetime includes AI, so no key is needed there." : ""}`}
        </p>

        {/* No live region below: this sits inside a collapsed panel, and hidden content is
            never announced, so the role would claim an announcement that cannot happen. */}
        {activeProviderStatus && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              Status:{" "}
              {activeProviderStatus.hasPersonalKey
                ? onLocalDevKeys
                  ? `Your ${providerMeta.label} key is saved, so Orbit uses it — clear it to fall back to .env.local`
                  : onLifetime
                    ? `Your ${providerMeta.label} key is saved, so Orbit uses it — clear it to switch to Orbit’s included AI`
                    : `Your ${providerMeta.label} key is saved`
                : provider === ai.selectedProvider && ai.reason
                  ? AI_NOTICE_COPY[ai.reason].title("use AI")
                  : managedRuns
                    ? onLocalDevKeys
                      ? `Using your .env.local ${providerMeta.label} key — ${modelLabel(provider, managedRuns)}`
                      : `Using Orbit’s included AI — ${modelLabel(provider, managedRuns)} on Orbit’s key`
                    : onLifetime && ai.source === "managed"
                      ? `No ${providerMeta.label} key — Orbit’s included AI runs on ${modelLabel(ai.provider, ai.model)} instead`
                      : "No key yet — paste one above to turn on AI features"}
            </p>
            {onLifetime && ai.allowance && (
              <p>
                Included AI this month: {allowancePercentUsed(ai.allowance)}% used · resets{" "}
                {formatAllowanceReset(ai.allowance.resetsAt)}
                {activeProviderStatus.hasPersonalKey ? " · not in use while your key is saved" : ""}
              </p>
            )}
            {managedRuns && !activeProviderStatus.hasPersonalKey && managedRuns !== model && (
              <p>
                On Orbit’s key, AI runs on {modelLabel(provider, managedRuns)}; the model you
                pick above applies once you add your own key.
              </p>
            )}
          </div>
        )}

        {provider === "anthropic" && (
          <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
            Anthropic has no embeddings API. Keep an OpenAI or Gemini key available
            so chat search can still embed contacts.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="model">Custom model ID</Label>
          <div className="flex gap-2">
            <Input
              id="model"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="model-id"
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending || !customModel.trim() || customModel.trim() === model}
              onClick={() =>
                start(async () => {
                  await save({ provider, model: customModel.trim() });
                })
              }
            >
              Use
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Runs {providerMeta.label} on an id of your own — anything the provider serves,
            including models with no tier above.
          </p>
          {movedFrom && model === DEFAULT_MODELS[provider] ? (
            <p className="text-xs text-muted-foreground">
              Moved from {modelLabel(provider, movedFrom)} to {modelLabel(provider, model)}: newer, and
              about half the price per token.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await save({ provider, model: movedFrom });
                  })
                }
              >
                Switch back
              </button>
            </p>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-border/60 pt-4">
          <h4 className="text-sm font-medium text-ink">Saved keys</h4>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {/* Same rule as the cards: a provider with no user-facing surface is not listed
                — unless this account actually holds a key for it, in which case the row is
                the only way to clear that key. */}
            {settings.providers
              .filter((p) => isSelectableAiProvider(p.id) || p.hasPersonalKey)
              .map((p) => (
                <li key={p.id} className="flex min-h-9 items-center justify-between gap-3">
                  <span>
                    {p.label}:{" "}
                    {p.hasPersonalKey
                      ? "saved"
                      : p.managedAvailable
                        ? onLocalDevKeys
                          ? "none — .env.local"
                          : "none — Orbit’s key"
                        : "none"}
                  </span>
                  {/* Per key, not per selected provider: switching provider used to leave the
                      old key live for embeddings and transcription with no way to remove it. */}
                  {p.hasPersonalKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Clear saved ${p.label} key`}
                      onClick={() =>
                        start(async () => {
                          await clearKey(p.id);
                        })
                      }
                    >
                      Clear
                    </Button>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      </Disclosure>
    </SettingsSection>
  );
}
