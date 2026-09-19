"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  clearApiKey,
  getSettings,
  saveAiSettings,
  saveVoiceSettings,
} from "@/actions/settings";
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  type AiProvider,
} from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import {
  AI_NOTICE_COPY,
  allowancePercentUsed,
  formatAllowanceReset,
} from "@/lib/ai-access-copy";
import { MANAGED_AI_ENABLED, managedModel } from "@/lib/managed-ai-policy";

type Settings = Awaited<ReturnType<typeof getSettings>>;

const CUSTOM_MODEL = "__custom__";

const PROVIDER_ITEMS = AI_PROVIDERS.map((p) => ({ value: p.id, label: p.label }));

function modelLabel(provider: AiProvider, id: string) {
  return PROVIDER_MODELS[provider].find((m) => m.value === id)?.label ?? id;
}

export function AiSettings({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  // A router refresh (the plan changed — Lifetime bought or revoked) hands down fresh
  // settings; adopt them rather than keep describing the old plan.
  const [seenInitial, setSeenInitial] = useState(initialSettings);
  if (seenInitial !== initialSettings) {
    setSeenInitial(initialSettings);
    setSettings(initialSettings);
  }
  const [provider, setProvider] = useState<AiProvider>(initialSettings.aiProvider);
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [wisprKey, setWisprKey] = useState("");
  const [model, setModel] = useState(initialSettings.aiModel);
  const [customModel, setCustomModel] = useState(
    !PROVIDER_MODELS[initialSettings.aiProvider].some(
      (m) => m.value === initialSettings.aiModel
    )
  );
  const [pending, start] = useTransition();

  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const models = PROVIDER_MODELS[provider];
  // `items` so each trigger shows the label ("Gemini 3.5 Flash"), not the stored id.
  const modelItems = [
    ...models.map((m) => ({ value: m.value, label: m.label })),
    { value: CUSTOM_MODEL, label: "Custom model ID…" },
  ];
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

  return (
    <SettingsSection
      title="AI provider"
      description={
        onLocalDevKeys
          ? "This dev server runs AI on the keys in your .env.local — nothing to set up. Save a key here and it is used instead, which is also how you see what a deployed account sees. Keys are encrypted at rest and only used for your account."
          : onLifetime
            ? "Orbit Lifetime includes AI on Orbit’s own keys — nothing to set up. You can still bring your own Gemini, OpenAI, or Anthropic key: whenever one is saved, Orbit uses yours instead. Keys are encrypted at rest and only used for your account."
            : `Choose Gemini, OpenAI, or Anthropic and paste your own API key. Keys are encrypted at rest and only used for your account.${ai.managedConfigured ? " Orbit Lifetime includes AI, so no key is needed there." : ""}`
      }
    >
      <div className="space-y-1.5">
        <Label id="provider-label">Provider</Label>
        <Select
          value={provider}
          onValueChange={(value) => {
            if (!value) return;
            const next = value as AiProvider;
            setProvider(next);
            setApiKey("");
            setKeyError(null);
            setModel(DEFAULT_MODELS[next]);
            setCustomModel(false);
          }}
          items={PROVIDER_ITEMS}
        >
          <SelectTrigger aria-labelledby="provider-label" className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} className="p-1">
            {PROVIDER_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {activeProviderStatus && (
        <div className="space-y-1 text-sm text-muted-foreground" role="status">
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
                    : "No key yet — paste one below to turn on AI features"}
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
              pick below applies once you add your own key.
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
        <Label htmlFor="key">{providerMeta.label} API key</Label>
        <Input
          id="key"
          type="password"
          placeholder={
            activeProviderStatus?.hasPersonalKey
              ? "•••••••• (leave blank to keep current)"
              : providerMeta.keyPlaceholder
          }
          value={apiKey}
          aria-invalid={keyError ? true : undefined}
          aria-describedby={keyError ? "key-error" : undefined}
          onChange={(e) => {
            setApiKey(e.target.value);
            setKeyError(null);
          }}
        />
        {keyError && (
          <p id="key-error" role="alert" className="text-sm text-destructive">
            {keyError}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label id="model-label" htmlFor={customModel ? "model" : undefined}>
          Model
        </Label>
        {!customModel ? (
          <Select
            value={model}
            onValueChange={(value) => {
              if (!value) return;
              if (value === CUSTOM_MODEL) {
                setCustomModel(true);
                return;
              }
              setModel(value);
            }}
            items={modelItems}
          >
            <SelectTrigger aria-labelledby="model-label" className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="p-1">
              {modelItems.map((item) => (
                <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex gap-2">
            <Input
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model-id"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCustomModel(false);
                setModel(DEFAULT_MODELS[provider]);
              }}
            >
              Presets
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            pending ||
            (!apiKey.trim() &&
              !activeProviderStatus?.hasPersonalKey &&
              !activeProviderStatus?.managedAvailable)
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() =>
            start(async () => {
              try {
                const res = await saveAiSettings({
                  provider,
                  model,
                  apiKey: apiKey.trim() || undefined,
                });
                if (!res.ok) {
                  setKeyError(res.error);
                  return;
                }
                setKeyError(null);
                setApiKey("");
                setSettings(await getSettings());
                toast.success(
                  res.keyNote ??
                    (res.embeddingReset
                      ? "Saved — search will re-index for the new provider"
                      : "AI settings saved")
                );
              } catch (err) {
                toast.error(
                  friendlyError(err, TOAST_COPY.saveFailed)
                );
              }
            })
          }
        >
          Save settings
        </Button>
        <Button
          variant="outline"
          disabled={pending || !activeProviderStatus?.hasPersonalKey}
          onClick={() =>
            start(async () => {
              try {
                await clearApiKey(provider);
                setSettings(await getSettings());
                toast.success(`${providerMeta.label} key cleared`);
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.saveFailed));
              }
            })
          }
        >
          Clear personal key
        </Button>
      </div>

      <SettingsRow
        title="Voice transcription"
        description={
          <>
            Voice notes are transcribed with{" "}
            <span className="font-medium text-foreground">Wispr Flow</span>{" "}
            when a key is saved here, because it accepts your contacts&apos; names as a vocabulary and
            gets their spelling right. Without one, Orbit falls back to your AI provider
            above — which still receives the same list of names, just less reliably.
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="wispr-key">Wispr Flow API key</Label>
          <Input
            id="wispr-key"
            type="password"
            autoComplete="off"
            placeholder={settings.hasWisprKey ? "Saved — enter a new key to replace" : "Optional"}
            value={wisprKey}
            onChange={(e) => setWisprKey(e.target.value)}
          />
        </div>
        {settings.wisprKeyRejected ? (
          <p role="status" className="text-sm text-warning">
            Wispr didn’t accept this key, so voice notes use your AI provider instead — replace it or clear it
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending || !wisprKey.trim()}
            onClick={() =>
              start(async () => {
                await saveVoiceSettings({ wisprApiKey: wisprKey.trim() });
                setWisprKey("");
                setSettings(await getSettings());
                toast.success("Wispr key saved");
              })
            }
          >
            Save Wispr key
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || !settings.hasWisprKey}
            onClick={() =>
              start(async () => {
                // "" clears; `undefined` would leave it untouched.
                await saveVoiceSettings({ wisprApiKey: "" });
                setSettings(await getSettings());
                toast.success("Wispr key cleared");
              })
            }
          >
            Clear
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow title="Saved keys">
        <ul className="space-y-1 text-sm text-muted-foreground">
          {settings.providers.map((p) => (
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
                      try {
                        const res = await clearApiKey(p.id);
                        setSettings(await getSettings());
                        toast.success(
                          res.embeddingReset
                            ? `${p.label} key cleared — search will re-index`
                            : `${p.label} key cleared`
                        );
                      } catch (err) {
                        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
                      }
                    })
                  }
                >
                  Clear
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}
