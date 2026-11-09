"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  clearApiKey,
  getSettings,
  saveAiSettings,
  saveChatAutoApply,
  saveWorkHistoryAutoEnabled,
} from "@/actions/settings";
import {
  AI_PROVIDERS,
  RECOMMENDED_KEY_PROVIDER,
  SELECTABLE_AI_PROVIDERS,
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
import { formatAllowanceReset, noticeCopyFor } from "@/lib/ai-access-copy";
import { useViewerPlan } from "@/components/viewer-plan";
import { managedModel } from "@/lib/managed-ai-policy";
import { setAiKeyPreference } from "@/actions/credits";
import { Briefcase, ExternalLink, MessageSquare } from "lucide-react";
import { CreditsDetails, CreditsNotice, CreditsTile, useCreditsOverview } from "@/components/credits/credits-card";
import { SegmentedControl, StatTile, SwitchRow } from "@/components/settings/account-rows";
import { AiUsageDetails, useAiUsage } from "@/components/settings/ai-usage-card";
import { DecisionModelSettings } from "@/components/settings/decision-model-settings";
import {
  SpeechDetails,
  formatMinutes,
  speechTotals,
  type SpeechAllowances,
} from "@/components/settings/speech-usage-card";

type Settings = Awaited<ReturnType<typeof getSettings>>;

function modelLabel(provider: AiProvider, id: string) {
  return PROVIDER_MODELS[provider].find((m) => m.value === id)?.label ?? id;
}

/**
 * The AI page: a row of stat tiles, one card per provider a person may choose, two switches,
 * and everything technical — usage detail, speech meters, Jev, saved keys — folded into
 * Advanced.
 *
 * SELECTABLE_AI_PROVIDERS, not AI_PROVIDERS: the full table also carries providers whose
 * plumbing exists but which no surface offers (OpenRouter). `providerMeta` below still looks
 * up the full table, so an account already on one keeps its real name in the copy.
 */
export function AiSettings({
  initialSettings,
  speech,
}: {
  initialSettings: Settings;
  speech: SpeechAllowances;
}) {
  const { planConfig } = useViewerPlan();
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
  const credits = useCreditsOverview();
  const usage = useAiUsage();

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
  const hasAnyPersonalKey = settings.providers.some((p) => p.hasPersonalKey);
  // Someone who needs a key to use AI at all gets the step-by-step; anyone covered by included
  // AI (or a dev server's own keys) only gets the "create a key" link on each card.
  const showKeyGuide = !hasAnyPersonalKey && !onLocalDevKeys && (ai.reason !== null || !onIncluded);
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

  const totals = speechTotals(speech);
  const running = ai.reason
    ? { value: "Off", sub: "No key yet" }
    : {
        value: modelLabel(ai.provider, ai.model),
        sub: ai.source === "personal" ? "Your key" : onLocalDevKeys ? ".env.local key" : "Orbit’s key",
      };

  return (
    <SettingsSection
      title="AI"
      description={
        onLocalDevKeys
          ? "Running on this dev server’s .env.local keys"
          : onIncluded && ai.plan === "free"
            ? `${planConfig.free.monthlyCredits ?? 0} credits a month on Free · add your own key for no limit`
            : onIncluded
              ? "Included on your plan · bring your own key to choose the model"
              : ai.managedConfigured && ai.managedPaused
                ? "Included AI is paused · add your own key to keep going"
                : "Add a key to turn on AI"
      }
    >
      <div className="@container">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <CreditsTile overview={credits.overview} />
          <StatTile label="Running" value={running.value} sub={running.sub} title={running.value} />
          <StatTile
            label="AI calls"
            value={usage === undefined ? undefined : usage === null ? null : usage.totalCalls.toLocaleString()}
            sub="your key · 30 days"
          />
          <StatTile
            label="Speech"
            value={formatMinutes(totals.used)}
            sub={totals.limit > 0 ? `of ${formatMinutes(totals.limit)}` : "Not on this plan"}
            title={`Resets ${formatAllowanceReset(speech.meeting.resetsAt)}`}
          />
        </div>
      </div>
      <CreditsNotice overview={credits.overview} />
      {credits.nudge}

      {showKeyGuide && <OwnKeyGuide />}

      {onIncluded && hasAnyPersonalKey && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink">Run AI on</p>
          <SegmentedControl
            label="Run AI on"
            options={[
              { value: "included" as const, label: "Orbit’s credits" },
              { value: "own" as const, label: "My key" },
            ]}
            // Unset means the pre-v2 rule: a saved key wins.
            value={ai.preference ?? "own"}
            disabled={pending}
            onChange={(next) =>
              start(async () => {
                const res = await setAiKeyPreference(next);
                if (!res.ok) {
                  toast.error(TOAST_COPY.saveFailed);
                  return;
                }
                setSettings(await getSettings());
                toast.success(next === "included" ? "Using Orbit’s included AI first" : "Using your own key first");
              })
            }
          />
        </div>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {SELECTABLE_AI_PROVIDERS.map((p) => (
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
          Moved from {modelLabel(provider, movedFrom)} to {modelLabel(provider, model)} · newer and about half the price{" "}
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

      <ul className="space-y-2">
        {/* The background half of work history: only the unattended re-checks, because they
            spend this account's key without anyone clicking. */}
        <SwitchRow
          icon={<Briefcase />}
          tone="var(--primary)"
          title="Keep work history current"
          description="Re-checks jobs with a web search · up to 20 a day"
          on={settings.workHistoryAutoEnabled}
          busy={pending}
          save={async (on) => {
            await saveWorkHistoryAutoEnabled(on);
            setSettings((s) => ({ ...s, workHistoryAutoEnabled: on }));
            return { ok: true };
          }}
          done={(on) => (on ? "Work history stays current" : "Work history re-checks off")}
          onSaved={() => {}}
        />
        {/* Off by default: every change chat suggests is a card to confirm; on, the small
            reversible ones happen and land as done cards with Undo. */}
        <SwitchRow
          icon={<MessageSquare />}
          tone="var(--primary)"
          title="Let chat make small changes"
          description="Notes, tags and reminders, with Undo · edits still ask first"
          on={settings.chatAutoApply}
          busy={pending}
          save={async (on) => {
            await saveChatAutoApply(on);
            setSettings((s) => ({ ...s, chatAutoApply: on }));
            return { ok: true };
          }}
          done={(on) => (on ? "Chat makes small changes for you" : "Chat asks before every change")}
          onSaved={() => {}}
        />
      </ul>

      <Disclosure label="Advanced">
        {/* No live region below: this sits inside a collapsed panel, and hidden content is
            never announced, so the role would claim an announcement that cannot happen. */}
        {activeProviderStatus && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              {activeProviderStatus.hasPersonalKey
                ? onLocalDevKeys
                  ? `Your ${providerMeta.label} key is saved, so Orbit uses it · clear it to fall back to .env.local`
                  : onIncluded
                    ? ai.source === "managed"
                      ? `Your ${providerMeta.label} key is saved · Orbit’s included AI runs first, as you chose`
                      : `Your ${providerMeta.label} key is saved and runs first · never uses credits`
                    : `Your ${providerMeta.label} key is saved`
                : provider === ai.selectedProvider && ai.reason
                  ? noticeCopyFor(ai.reason, ai.plan, null, planConfig).title("use AI")
                  : managedRuns
                    ? onLocalDevKeys
                      ? `Using your .env.local ${providerMeta.label} key · ${modelLabel(provider, managedRuns)}`
                      : `Using Orbit’s included AI · ${modelLabel(provider, managedRuns)} on Orbit’s key`
                    : onIncluded && ai.source === "managed"
                      ? `No ${providerMeta.label} key · Orbit’s included AI runs on ${modelLabel(ai.provider, ai.model)}`
                      : "No key yet · paste one above to turn on AI"}
            </p>
            {managedRuns && !activeProviderStatus.hasPersonalKey && managedRuns !== model && (
              <p>The model you pick above applies once you add your own key</p>
            )}
            <p>Keys are encrypted at rest and only used for your account</p>
          </div>
        )}

        {provider === "anthropic" && (
          <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
            Anthropic has no embeddings API · keep an OpenAI or Gemini key so chat search can embed contacts
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="model">Custom model ID</Label>
          <div className="flex gap-2">
            {/*
              A datalist rather than a select: the tiers are the ids worth suggesting, but this
              field is the one way to reach a model Orbit has not tagged — a preview id, or the
              id an account is already stored on.
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
          <p className="text-xs text-muted-foreground">Any id {providerMeta.label} serves, tiered or not</p>
        </div>

        <AdvancedBlock title="Saved keys">
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
                          ? "none · .env.local"
                          : "none · Orbit’s key"
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
        </AdvancedBlock>

        {credits.overview ? (
          <AdvancedBlock title="Credits">
            <CreditsDetails overview={credits.overview} />
          </AdvancedBlock>
        ) : null}

        <AdvancedBlock title="Usage on your key · 30 days">
          <AiUsageDetails summary={usage} />
        </AdvancedBlock>

        <AdvancedBlock title="Speech-to-text · Orbit’s key">
          <SpeechDetails speech={speech} />
        </AdvancedBlock>

        <div className="border-t border-border/60 pt-4">
          <DecisionModelSettings initialSettings={initialSettings} />
        </div>
      </Disclosure>
    </SettingsSection>
  );
}

/**
 * Step by step, for someone who needs a key to use AI at all: one provider recommended, three
 * steps, and the link straight to where the key is made. The other cards each carry their own
 * link. Nothing here saves anything — the key still goes in a card below.
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

function AdvancedBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-4">
      <h4 className="text-sm font-medium text-ink">{title}</h4>
      {children}
    </div>
  );
}
