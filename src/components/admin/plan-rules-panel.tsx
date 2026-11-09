"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { resetPlanRuleAction, setFeaturePlansAction, setPlanLimitAction } from "@/actions/admin";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import {
  FEATURE_KEYS,
  PLANS,
  PLAN_SHORT_LABELS,
  formatSpeechAllowance,
  type FeatureKey,
  type Plan,
  type PlanConfig,
} from "@/lib/plans/plan-config";
import {
  LIMIT_FIELDS,
  LIMIT_MIN,
  NULLABLE_LIMIT_FIELDS,
  limitOf,
  plansWithFeature,
  type LimitField,
  type LimitValue,
  type PlanRules,
} from "@/lib/plans/plan-overrides";
import { cn } from "@/lib/utils";

type Config = Record<Plan, PlanConfig>;

const FEATURE_INFO: Record<FeatureKey, { label: string; description: string }> = {
  outreach: { label: "Outreach", description: "Campaigns, prospects and sequences (ships coming soon)." },
  hostedSending: { label: "Sending on Orbit's credentials", description: "Email and SMS sent through Orbit's own Resend and Twilio." },
  hostedEnrichment: { label: "Hosted enrichment", description: "Contact enrichment on Orbit's Apollo key. Not sold; a user's own key always works." },
  recruiters: { label: "Recruiter tracking", description: "The Recruiters page, its scan and its actions." },
  sync: { label: "Calendar subscriptions", description: "Pasted ICS feeds and event sources." },
  extension: { label: "Extension", description: "The browser extension's plan flag (its core is free regardless)." },
  api: { label: "REST API and webhooks", description: "API keys and outbound webhooks. MCP stays free on every plan." },
  crm: { label: "CRM sync", description: "Connecting Salesforce or HubSpot to Leads. Joining a team and warm paths stay free." },
  meetings: { label: "Meeting recording", description: "Record and transcribe new meetings. Past meetings stay readable." },
  hostedAi: { label: "Included AI", description: "AI on Orbit's keys, metered in the plan's credits." },
  creditPacks: { label: "Credit packs", description: "Buying a $5 top-up pack of AI credits." },
  extraConnections: { label: "Google and Microsoft both", description: "A second mail/calendar account. Also sets the connections limit below." },
  radar: { label: "Radar", description: "Who to reach out to this week (page.radar)." },
  events: { label: "Events", description: "Events, attendee lists and the extension's roster (page.events)." },
  findPeople: { label: "Find people", description: "Research people outside the network (page.find and its chat tools)." },
  compose: { label: "Compose email", description: "Write and send email from a contact or ⌘K." },
  cloudNotes: { label: "Cloud notes", description: "Meeting notes found in Google Drive and OneDrive." },
};

const LIMIT_INFO: Record<LimitField, { label: string; unit: string }> = {
  contactLimit: { label: "Contacts", unit: "contacts" },
  monthlyCredits: { label: "AI credits / month", unit: "credits" },
  "speech.meetingSeconds": { label: "Meeting transcription / month", unit: "seconds" },
  "speech.shortformSeconds": { label: "Voice notes and chat mic / month", unit: "seconds" },
  googleMicrosoftConnections: { label: "Google + Microsoft accounts", unit: "accounts" },
};

const PAID: Plan[] = ["orbit", "max", "lifetime"];
const sameList = (a: readonly Plan[], b: readonly Plan[]) => a.join() === b.join();

function useSaver() {
  const router = useRouter();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function run(key: string, fn: () => Promise<unknown>, rollback: () => void) {
    setBusy((prev) => new Set(prev).add(key));
    setErrors(({ [key]: _drop, ...rest }) => rest);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      rollback();
      setErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Could not save that." }));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }
  return { busy, errors, run };
}

const chipClass = (on: boolean) =>
  cn(
    "rounded-md border px-2 py-0.5 text-2xs transition-colors duration-fast disabled:opacity-60",
    on
      ? "border-tier-border bg-tier-surface font-medium text-tier-accent"
      : "border-border/60 text-muted-foreground-subtle line-through decoration-muted-foreground/40 hover:text-foreground"
  );

/**
 * Every plan feature with a chip per plan. A chip that would take the feature away from
 * accounts paying for that plan opens a confirm dialog naming how many first.
 */
export function PlanFeatureRules({
  config,
  defaults,
  overridden,
  paying,
}: {
  config: Config;
  defaults: Config;
  /** Features with an operator rule (anything else is the code default). */
  overridden: string[];
  /** Accounts paying for each plan right now. */
  paying: Record<Plan, number>;
}) {
  const [local, setLocal] = useState<Partial<Record<FeatureKey, Plan[]>>>({});
  const { busy, errors, run } = useSaver();
  const plansFor = (f: FeatureKey) => local[f] ?? plansWithFeature(config, f);

  function save(feature: FeatureKey, plans: Plan[]) {
    setLocal((prev) => ({ ...prev, [feature]: plans }));
    return run(
      feature,
      () => setFeaturePlansAction({ feature, plans }),
      () => setLocal(({ [feature]: _drop, ...rest }) => rest)
    );
  }

  function reset(feature: FeatureKey) {
    setLocal((prev) => ({ ...prev, [feature]: plansWithFeature(defaults, feature) }));
    return run(
      feature,
      () => resetPlanRuleAction({ kind: "feature", feature }),
      () => setLocal(({ [feature]: _drop, ...rest }) => rest)
    );
  }

  return (
    <ul className="divide-y divide-border/50">
      {FEATURE_KEYS.map((feature) => {
        const plans = plansFor(feature);
        const isDefault = local[feature]
          ? sameList(plans, plansWithFeature(defaults, feature))
          : !overridden.includes(feature);
        const disabled = busy.has(feature);
        const info = FEATURE_INFO[feature];
        return (
          <li key={feature} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <div className="min-w-0 flex-1 basis-64">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {info.label}
                <code className="rounded bg-muted/60 px-1 text-[0.6875rem] text-muted-foreground">{feature}</code>
                {isDefault ? (
                  <span className="rounded bg-muted/60 px-1.5 text-2xs text-muted-foreground">Default</span>
                ) : (
                  <span className="rounded bg-warning/15 px-1.5 text-2xs text-amber-800 dark:text-warning">Custom</span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{info.description}</p>
              {plans.length === 0 && (
                <p className="mt-1 text-xs text-amber-800 dark:text-warning">No plan has this — nobody but admins and demo accounts can use it.</p>
              )}
              {errors[feature] && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {errors[feature]}
                </p>
              )}
            </div>

            <div role="group" aria-label={`${info.label}: plans that get it`} className="flex shrink-0 gap-1">
              {PLANS.map((plan) => {
                const on = plans.includes(plan);
                const next = on ? plans.filter((p) => p !== plan) : PLANS.filter((p) => p === plan || plans.includes(p));
                const label = PLAN_SHORT_LABELS[plan];
                if (on && paying[plan] > 0) {
                  return (
                    <ConfirmActionDialog
                      key={plan}
                      trigger={
                        <button type="button" aria-pressed disabled={disabled} className={chipClass(true)}>
                          {label}
                        </button>
                      }
                      title={`Take ${info.label} off ${label}?`}
                      description={`${paying[plan]} account${paying[plan] === 1 ? " is" : "s are"} paying for ${label} right now. They keep their data but lose new use of ${info.label} within about 15 seconds.`}
                      confirmLabel={`Remove from ${label}`}
                      danger
                      // Called directly, not through `save`: the dialog shows its own error toast and refreshes.
                      onConfirm={(reason) => setFeaturePlansAction({ feature, plans: next, reason })}
                    />
                  );
                }
                return (
                  <button
                    key={plan}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    title={on ? `${label} has it — click to take it away` : `${label} doesn't have it — click to give it`}
                    onClick={() => void save(feature, next)}
                    className={chipClass(on)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="flex shrink-0 gap-1 text-2xs">
              {(
                [
                  ["Free (everyone)", [...PLANS]],
                  ["All paid", PAID],
                ] as const
              ).map(([text, preset]) => (
                <button
                  key={text}
                  type="button"
                  // A preset that would take the feature from paying accounts goes through the chips' dialog instead.
                  disabled={disabled || sameList(plans, preset) || PLANS.some((p) => plans.includes(p) && !preset.includes(p) && paying[p] > 0)}
                  onClick={() => void save(feature, [...preset])}
                  className="rounded-md border border-border/70 px-2 py-0.5 text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-40"
                >
                  {text}
                </button>
              ))}
              <button
                type="button"
                disabled={disabled || isDefault}
                onClick={() => void reset(feature)}
                aria-label={`Reset ${info.label} to the default`}
                title="Reset to the default"
                className="rounded-md border border-border/70 p-1 text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-25"
              >
                <RotateCcw className="size-3" aria-hidden />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const show = (v: LimitValue) => (v === null ? "unlimited" : String(v));

/** Every numeric limit, one row per field and one cell per plan, edited inline. */
export function PlanLimitRules({ config, defaults, rules }: { config: Config; defaults: Config; rules: PlanRules }) {
  const { busy, errors, run } = useSaver();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  function commit(plan: Plan, field: LimitField) {
    const key = `${plan}:${field}`;
    const raw = drafts[key];
    if (raw === undefined) return;
    const text = raw.trim().toLowerCase();
    const current = limitOf(config[plan], field);
    const drop = () => setDrafts(({ [key]: _d, ...rest }) => rest);
    let value: LimitValue;
    if (text === "unlimited" && NULLABLE_LIMIT_FIELDS.has(field)) value = null;
    else if (/^\d+$/.test(text) && Number(text) >= LIMIT_MIN[field]) value = Number(text);
    else {
      drop();
      return;
    }
    if (value === current) return drop();
    void run(key, () => setPlanLimitAction({ plan, field, value }), drop).then(drop);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-normal">Limit</th>
            {PLANS.map((p) => (
              <th key={p} className="px-2 py-2 font-normal">
                {PLAN_SHORT_LABELS[p]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {LIMIT_FIELDS.map((field) => (
            <tr key={field}>
              <td className="py-2 pr-3 align-top">
                {LIMIT_INFO[field].label}
                <p className="text-2xs text-muted-foreground">
                  {LIMIT_INFO[field].unit}
                  {NULLABLE_LIMIT_FIELDS.has(field) ? ", or “unlimited”" : ""}
                </p>
              </td>
              {PLANS.map((plan) => {
                const key = `${plan}:${field}`;
                const value = limitOf(config[plan], field);
                const custom = rules.limits[plan]?.[field] !== undefined;
                return (
                  <td key={plan} className="px-2 py-2 align-top">
                    <div className="flex items-center gap-1">
                      <input
                        aria-label={`${LIMIT_INFO[field].label} on ${PLAN_SHORT_LABELS[plan]}`}
                        value={drafts[key] ?? show(value)}
                        disabled={busy.has(key)}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                        onBlur={() => commit(plan, field)}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        className={cn(
                          "w-24 rounded-md border bg-transparent px-2 py-1 text-xs tabular-nums",
                          custom ? "border-warning/60" : "border-border/70"
                        )}
                      />
                      {custom && (
                        <button
                          type="button"
                          disabled={busy.has(key)}
                          onClick={() => void run(key, () => resetPlanRuleAction({ kind: "limit", plan, field }), () => {})}
                          aria-label={`Reset to the default (${show(limitOf(defaults[plan], field))})`}
                          title={`Reset to the default (${show(limitOf(defaults[plan], field))})`}
                          className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-25"
                        >
                          <RotateCcw className="size-3" aria-hidden />
                        </button>
                      )}
                    </div>
                    {field.startsWith("speech.") && value !== null && (
                      <p className="mt-0.5 text-2xs text-muted-foreground">{formatSpeechAllowance(value)}</p>
                    )}
                    {errors[key] && (
                      <p role="alert" className="mt-0.5 text-2xs text-destructive">
                        {errors[key]}
                      </p>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted-foreground">
        An amber border marks a limit changed from the default. A raised AI credit allowance lands in the
        current cycle; a lowered one from the next. Speech allowances and the contact cap apply at once.
      </p>
    </div>
  );
}
