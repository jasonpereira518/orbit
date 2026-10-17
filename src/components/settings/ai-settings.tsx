"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  clearApiKey,
  getSettings,
  saveAiSettings,
  saveWorkHistoryAutoEnabled,
} from "@/actions/settings";
import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import {
  AI_PROVIDERS,
  SELECTABLE_AI_PROVIDERS,
  RECOMMENDED_KEY_PROVIDER,
  detectKeyProvider,
  isSelectableAiProvider,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  tieredModels,
  type AiProvider,
} from "@/lib/ai-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "@/components/settings/settings-section";
import { Disclosure } from "@/components/settings/disclosure";
import { ClearKeyButton, ProviderCard, SAVE_THREW, TIER_LABELS } from "@/components/settings/provider-card";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { FREE_AI_EXPLAINER, OWN_KEY_PROVIDERS, noticeCopyFor } from "@/lib/ai-access-copy";
import { managedModel } from "@/lib/managed-ai-policy";
import { setAiKeyPreference } from "@/actions/credits";
import { CreditsCard } from "@/components/credits/credits-card";

type Settings = Awaited<ReturnType<typeof getSettings>>;

function modelLabel(provider: AiProvider, id: string) {
  return PROVIDER_MODELS[provider].find((m) => m.value === id)?.label ?? id;
}

/**
 * The AI page: one card per provider a person may choose, and everything technical folded
 * into Advanced.
 *
 * SELECTABLE_AI_PROVIDERS, not AI_PROVIDERS: only providers a person may pick get a card.
 * OpenRouter's card sits in Advanced unless the account is already on it, so someone looking
 * for their first key meets three choices, one of them recommended. `providerMeta` below still
 * looks up the full table, so an account on any provider keeps its real name in the copy.
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
   * Set when a default changed under this account (`ai_model_migrated_from`). Shown once, on
   * the card body rather than inside Advanced: `saveAiSettings` clears the flag on ANY save,
   * so anyone who picked a tier before opening Advanced burned the notice without reading it
   * — and it discloses an automatic model change made on their own spend.
   */
  const movedFrom = settings.aiModelMigratedFrom;
  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const activeProviderStatus = settings.providers.find((p) => p.id === provider);
  const { ai } = settings;
  // A dev server running on the keys in `.env.local`: the included-AI machinery, but the
  // developer's own key, so it says so rather than promising what no deployment does.
  const onLocalDevKeys = ai.eligibility === "demo" && ai.managedConfigured;
  // Every plan: AI included on Orbit's keys (unless paused).
  const onIncluded = ai.eligibility === "plan" && ai.managedConfigured && !ai.managedPaused;
  // Included AI exists on this deployment but is paused or out of budget for everyone.
  const includedPaused = ai.eligibility === "plan" && ai.managedConfigured && ai.managedPaused;
  const hasAnyPersonalKey = settings.providers.some((p) => p.hasPersonalKey);
  // Someone who needs a key to use AI at all gets the step-by-step; anyone covered by included
  // AI (or a dev server's own keys) only gets the "create a key" link on each card.
  const showKeyGuide = !hasAnyPersonalKey && !onLocalDevKeys && (ai.reason !== null || !onIncluded);
  // OpenRouter is for people who already use it: in Advanced, unless this account is on it.
  const openRouterInGrid =
    provider === "openrouter" || Boolean(settings.providers.find((p) => p.id === "openrouter")?.hasPersonalKey);
  const gridProviders = SELECTABLE_AI_PROVIDERS.filter((p) => p.id !== "openrouter" || openRouterInGrid);
  const advancedProviders = SELECTABLE_AI_PROVIDERS.filter((p) => !gridProviders.includes(p));
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
  }): Promise<string | null | typeof SAVE_THREW> {
    // A key pasted into the wrong card goes to the provider it belongs to, rather than being
    // refused by the one it was pasted into. Only a key's prefix decides; the save verifies it.
    const detected = input.apiKey ? detectKeyProvider(input.apiKey) : null;
    const target = detected && detected !== input.provider && isSelectableAiProvider(detected) ? detected : input.provider;
    const moved = target !== input.provider;
    try {
      const res = await saveAiSettings({
        provider: target,
        // Saving a key on a provider that is not the active one moves the account to it, so
        // the stored model has to move too — otherwise it keeps the old provider's id.
        model:
          (moved ? undefined : input.model) ??
          (target === settings.aiProvider ? undefined : DEFAULT_MODELS[target]),
        apiKey: input.apiKey,
      });
      if (!res.ok) return res.error;
      const next = await getSettings();
      setSettings(next);
      setCustomModel(next.aiModel);
      const targetLabel = AI_PROVIDERS.find((p) => p.id === target)?.label ?? target;
      toast.success(
        moved
          ? `That looks like ${/^[aeiou]/i.test(targetLabel) ? "an" : "a"} ${targetLabel} key, so Orbit saved it there`
          : (res.keyNote ??
              (res.embeddingReset
                ? "Saved — search will re-index for the new provider"
                : "AI settings saved"))
      );
      return null;
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      // Not `null`: that is what a save that went through returns, and a card reading it as
      // success would clear the key field the user had just pasted into.
      return SAVE_THREW;
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
      description={
        onIncluded && ai.plan === "free"
          ? FREE_AI_EXPLAINER
          : onIncluded
            ? "Orbit uses AI to turn your notes into contacts and answer questions about your network. Your plan includes AI on Orbit’s keys, metered in credits. Orbit picks the model for it (Claude Haiku 5.5, with OpenAI as backup) — or bring your own key to choose, which never uses credits."
            : includedPaused
              ? "Orbit uses AI to turn your notes into contacts and answer questions about your network. Orbit’s included AI is paused right now, so to use AI meanwhile, add a key of your own below. Keys are encrypted at rest and only used for your account."
              : "Orbit uses AI to turn your notes into contacts and answer questions about your network. Pick a provider and paste its key — keys are encrypted at rest and only used for your account."
      }
    >
      <CreditsCard paused={includedPaused} />

      {showKeyGuide && <OwnKeyGuide />}

      {onIncluded && hasAnyPersonalKey && (
        <KeyPreference
          value={ai.preference}
          onChange={async (next) => {
            const res = await setAiKeyPreference(next);
            if (!res.ok) {
              toast.error(TOAST_COPY.saveFailed);
              return;
            }
            setSettings(await getSettings());
            toast.success(next === "included" ? "Using Orbit’s included AI first" : "Using your own key first");
          }}
        />
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {gridProviders.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            status={settings.providers.find((s) => s.id === p.id)}
            active={p.id === provider}
            model={p.id === provider ? model : null}
            includedCovers={onIncluded}
            recommended={showKeyGuide && p.id === RECOMMENDED_KEY_PROVIDER}
            onSave={save}
            onClear={clearKey}
          />
        ))}
      </ul>

      {movedFrom ? (
        <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
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

      {/* The background half of work history. LinkedIn pulls and the profile's own button
          search regardless; this only governs the unattended re-checks, because they spend
          this account's key without anyone clicking. */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border/70 p-3">
        <div className="space-y-0.5">
          <p id="work-history-auto-label" className="text-sm font-medium text-ink">
            Keep work history current
          </p>
          <p className="text-sm text-muted-foreground">
            Re-checks contacts&rsquo; jobs with a web search on your AI key — closest people
            monthly, everyone else less often, at most 20 lookups a day — and notes when
            someone changes jobs.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.workHistoryAutoEnabled}
          aria-labelledby="work-history-auto-label"
          disabled={pending}
          onClick={() => {
            const next = !settings.workHistoryAutoEnabled;
            setSettings({ ...settings, workHistoryAutoEnabled: next });
            start(async () => {
              try {
                await saveWorkHistoryAutoEnabled(next);
              } catch (err) {
                setSettings({ ...settings, workHistoryAutoEnabled: !next });
                toast.error(friendlyError(err, TOAST_COPY.saveFailed));
              }
            });
          }}
          className={cn(
            "tap-target relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors duration-fast ease-house focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
            settings.workHistoryAutoEnabled ? "bg-primary" : "bg-muted-foreground/30"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "pointer-events-none size-4 rounded-full bg-background shadow-sm transition-transform duration-fast ease-house",
              settings.workHistoryAutoEnabled ? "translate-x-[1.125rem]" : "translate-x-0.5"
            )}
          />
        </button>
      </div>

      <Disclosure label="Advanced">
        <p className="text-sm text-muted-foreground">
          {onLocalDevKeys
            ? "This dev server runs AI on the keys in your .env.local — nothing to set up. Save a key above and it is used instead, which is also how you see what a deployed account sees. Keys are encrypted at rest and only used for your account."
            : onIncluded
              ? `Your plan includes AI on Orbit’s own keys — nothing to set up. You can still bring your own ${OWN_KEY_PROVIDERS} key and choose which runs first; calls on your own key never use credits. Keys are encrypted at rest and only used for your account.`
              : `Choose a provider above and paste your own API key. Keys are encrypted at rest and only used for your account.${includedPaused ? " Orbit’s included AI is paused right now, so your own key is how to use AI until it’s back." : ""}`}
        </p>

        {advancedProviders.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Already use OpenRouter? One key there reaches many providers’ models.
            </p>
            <ul className="grid gap-3 sm:grid-cols-2">
              {advancedProviders.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  status={settings.providers.find((s) => s.id === p.id)}
                  active={p.id === provider}
                  model={p.id === provider ? model : null}
                  includedCovers={onIncluded}
                  onSave={save}
                  onClear={clearKey}
                />
              ))}
            </ul>
          </div>
        )}

        {/* No live region below: this sits inside a collapsed panel, and hidden content is
            never announced, so the role would claim an announcement that cannot happen. */}
        {activeProviderStatus && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              Status:{" "}
              {activeProviderStatus.hasPersonalKey
                ? onLocalDevKeys
                  ? `Your ${providerMeta.label} key is saved, so Orbit uses it — clear it to fall back to .env.local`
                  : onIncluded
                    ? ai.source === "managed"
                      ? `Your ${providerMeta.label} key is saved; Orbit’s included AI runs first, as you chose`
                      : `Your ${providerMeta.label} key is saved and runs first — it never uses credits`
                    : `Your ${providerMeta.label} key is saved`
                : provider === ai.selectedProvider && ai.reason
                  ? noticeCopyFor(ai.reason, ai.plan, null).title("use AI")
                  : managedRuns
                    ? onLocalDevKeys
                      ? `Using your .env.local ${providerMeta.label} key — ${modelLabel(provider, managedRuns)}`
                      : `Using Orbit’s included AI — ${modelLabel(provider, managedRuns)} on Orbit’s key`
                    : onIncluded && ai.source === "managed"
                      ? `No ${providerMeta.label} key — Orbit’s included AI runs on ${modelLabel(ai.provider, ai.model)} instead`
                      : "No key yet — paste one above to turn on AI features"}
            </p>
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
            {/*
              A datalist rather than a select: the tiers are the ids worth suggesting, but this
              field is the one way to reach a model Orbit has not tagged — a preview id, or the
              id an account is already stored on. A select would make those unreachable from
              the UI entirely, which is the opposite of what an escape hatch is for.
            */}
            <Input
              id="model"
              list={`${provider}-model-options`}
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="model-id"
            />
            <datalist id={`${provider}-model-options`}>
              {tieredModels(provider).map((m) => (
                <option
                  key={m.value}
                  value={m.value}
                  label={m.tier ? `${TIER_LABELS[m.tier]} — ${m.label}` : m.label}
                />
              ))}
            </datalist>
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
                    <ClearKeyButton
                      label={p.label}
                      resetsSearch={p.clearResetsSearch}
                      disabled={pending}
                      variant="ghost"
                      aria-label={`Clear saved ${p.label} key`}
                      onConfirm={() => start(async () => { await clearKey(p.id); })}
                    >
                      Clear
                    </ClearKeyButton>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      </Disclosure>
    </SettingsSection>
  );
}

/**
 * Step by step, for someone who needs a key to use AI at all: one provider recommended, three
 * steps, and the link straight to where the key is made. The other providers' cards each carry
 * their own link. Nothing here saves anything — the key still goes in a card below.
 */
function OwnKeyGuide() {
  const meta = AI_PROVIDERS.find((p) => p.id === RECOMMENDED_KEY_PROVIDER)!;
  return (
    <section aria-labelledby="own-key-guide" className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
      <div className="space-y-1">
        <h3 id="own-key-guide" className="font-heading text-base text-ink">
          Use your own AI key
        </h3>
        <p className="text-sm text-muted-foreground">
          Orbit can run on an AI account of your own. You pay the provider directly, and it never uses your Orbit
          credits
        </p>
      </div>
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
          {meta.label}
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            Recommended
          </span>
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-foreground marker:text-muted-foreground">
          <li>
            Open Google AI Studio and sign in with your Google account.{" "}
            <a
              href={meta.keyPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
            >
              {meta.keyPageLabel}
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
          <li>Press Create API key, then copy it</li>
          <li>Paste it into the {meta.label} card below and press Save. Orbit checks it straight away</li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Google’s free tier has usage limits and its own data terms. Check them before you use it for notes about
          other people
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Prefer OpenAI or Anthropic? Their cards below link to where you make a key, and a key pasted into the wrong
        card still lands in the right one
      </p>
    </section>
  );
}

/**
 * Which key runs first when a Pro or Max account has both. Included AI spends credits; the
 * account's own key never does. Only offered when there is a real choice to make.
 */
function KeyPreference({
  value,
  onChange,
}: {
  value: "included" | "own" | null;
  onChange: (next: "included" | "own") => Promise<void>;
}) {
  const [pending, start] = useTransition();
  // Unset means the pre-v2 rule: a saved key wins.
  const current = value ?? "own";
  const options = [
    { id: "included" as const, label: "Orbit’s included AI", hint: "Uses your credits" },
    { id: "own" as const, label: "My own key", hint: "Never uses credits" },
  ];
  return (
    <fieldset className="space-y-2 rounded-xl border border-border/70 p-4" disabled={pending}>
      <legend className="px-1 text-sm font-medium text-ink">Run AI on</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.id}
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 p-3 text-sm has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name="ai-key-preference"
              value={o.id}
              checked={current === o.id}
              onChange={() => start(() => onChange(o.id))}
              className="mt-0.5"
            />
            <span>
              <span className="block text-ink">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
