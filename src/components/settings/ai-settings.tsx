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

type Settings = Awaited<ReturnType<typeof getSettings>>;

const CUSTOM_MODEL = "__custom__";

const PROVIDER_ITEMS = AI_PROVIDERS.map((p) => ({ value: p.id, label: p.label }));

export function AiSettings({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [provider, setProvider] = useState<AiProvider>(initialSettings.aiProvider);
  const [apiKey, setApiKey] = useState("");
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

  return (
    <SettingsSection
      title="AI provider"
      description="Choose Gemini, OpenAI, or Anthropic and paste your own API key. Keys are encrypted at rest and only used for your account."
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
        <p className="text-sm text-muted-foreground">
          Status:{" "}
          {activeProviderStatus.hasPersonalKey
            ? "Your key is saved"
            : activeProviderStatus.usingEnv
              ? `Using local ${activeProviderStatus.envVar} (dev only)`
              : "No key yet — paste one below to enable AI features"}
        </p>
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
          onChange={(e) => setApiKey(e.target.value)}
        />
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
              !activeProviderStatus?.usingEnv)
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
                setApiKey("");
                setSettings(await getSettings());
                toast.success(
                  res.embeddingReset
                    ? "Saved — search will re-index for the new provider"
                    : "AI settings saved"
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
            <li key={p.id}>
              {p.label}:{" "}
              {p.hasPersonalKey ? "saved" : p.usingEnv ? "local env" : "none"}
            </li>
          ))}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}
