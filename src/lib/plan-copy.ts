import {
  FREE_STARTER_CREDITS,
  PLANS,
  PLAN_CONFIG,
  PLAN_LABELS,
  annualMonthlyEquivalentCents,
  formatPlanPrice,
  formatSpeechAllowance,
  type BillingPeriod,
  type FeatureKey,
  type Plan,
  type PlanConfig,
  type PurchasablePlan,
} from "@/lib/plans/plan-config";
import { CREDIT_PACK_CREDITS, CREDIT_PACK_PRICE_LABEL } from "@/lib/stripe-config";

export type { BillingPeriod } from "@/lib/plans/plan-config";
export { ANNUAL_SAVING_PERCENT } from "@/lib/plans/plan-config";
import { FOUNDING_AMOUNT_OFF_CENTS, FOUNDING_MONTHS } from "@/lib/stripe-config";
import type { DemoAccountReason } from "@/lib/demo-account";

/**
 * Single source of truth for how the tiers are described, so the marketing pricing
 * page, the settings card, and any upgrade prompt cannot drift from each other —
 * the same reason `settings/sections.ts` centralises the settings rail.
 *
 * Prices are read from `PLAN_CONFIG`, which is also what the gates enforce; the amount
 * actually charged is the Stripe price with the matching lookup key.
 *
 * TWO RULES THIS COPY KEEPS:
 *  - Only shipped features. Outreach is behind its coming-soon gate, and the
 *    Chrome extension stays out of plan copy until `EXTENSION_PUBLISHED`; none appear until they ship.
 *    (The coming-soon screen and nav tooltip may say which plan a surface WILL unlock on —
 *    `COMING_SOON_UNLOCK_PLAN` — but pricing and plan cards still never list it.)
 *  - No fake urgency: no struck-through prices, countdowns or scarcity. A founding price is
 *    shown only to an eligible account, and always with its full terms.
 *
 * Display names and internal ids are deliberately decoupled: "Orbit Pro" is id `orbit`,
 * persisted in `user_settings` and Stripe metadata. Rename the copy freely; renaming an id
 * is a data migration.
 */

export type PlanPrice = {
  amount: string;
  /** Sits beside the amount, e.g. "per month". */
  cadence: string;
  /** Second line under the price, only where the billing needs explaining. */
  footnote?: string;
};

export type PlanCopy = {
  id: Plan;
  name: string;
  tagline: string;
  /** What the card shows for each billing period the toggle offers. */
  price: Record<BillingPeriod, PlanPrice>;
  features: string[];
  /** Shown under the feature list where a tier deliberately excludes something. */
  caveat?: string;
};

/**
 * The Chrome Web Store listing, set at build time (NEXT_PUBLIC_* is inlined) once the extension is
 * published. Unset means unpublished: every surface that offers it shows "soon" or nothing.
 */
export const EXTENSION_STORE_URL = process.env.NEXT_PUBLIC_EXTENSION_URL?.trim() || null;
export const EXTENSION_PUBLISHED = EXTENSION_STORE_URL !== null;

/** The one-line positioning, used wherever plans are summarised. */
export const AI_POSITIONING = "Free: a small AI allowance to start. Pro and Max: AI included.";

const HOURS = formatSpeechAllowance;

/** A paid plan's two prices. Annual is two months free, and says what that works out to. */
function prices(plan: PurchasablePlan): Record<BillingPeriod, PlanPrice> {
  return {
    monthly: { amount: formatPlanPrice(PLAN_CONFIG[plan].monthlyPriceCents ?? 0), cadence: "per month" },
    annual: {
      amount: formatPlanPrice(PLAN_CONFIG[plan].annualPriceCents ?? 0),
      cadence: "per year",
      // One line on the narrowest card: the saving first, then what it works out to.
      footnote: `Two months free · ${formatPlanPrice(annualMonthlyEquivalentCents(plan))}/mo`,
    },
  };
}

function samePrice(price: PlanPrice): Record<BillingPeriod, PlanPrice> {
  return { monthly: price, annual: price };
}

type Config = Record<Plan, PlanConfig>;

/**
 * The gated features plan copy may name, each with its bullet and the phrase an "Everything
 * in X, except …" line uses. Every other `FeatureKey` stays out of plan copy: coming-soon
 * features (Outreach, Events, Radar, Find people, compose, cloud notes) until they ship, the
 * extension until `EXTENSION_PUBLISHED`, and the ones no plan sells (hosted enrichment).
 */
const LISTED: Partial<Record<FeatureKey, { bullet: string; except: string }>> = {
  creditPacks: { bullet: `Top up with ${CREDIT_PACK_PRICE_LABEL} packs of ${CREDIT_PACK_CREDITS} credits`, except: "credit packs" },
  recruiters: { bullet: "Recruiter tracking", except: "recruiter tracking" },
  extraConnections: { bullet: "Connect both Google and Microsoft", except: "connecting both Google and Microsoft" },
  sync: { bullet: "Calendar subscriptions", except: "calendar subscriptions" },
  meetings: { bullet: "Meeting transcription", except: "meeting transcription" },
  api: { bullet: "REST API and webhooks", except: "the REST API and webhooks" },
};
const LISTED_KEYS = Object.keys(LISTED) as FeatureKey[];

/**
 * One line of a plan's feature list. `feature` ties the line to a gate: the line shows only
 * while the plan has that feature under the config. `text` may return null to drop the line.
 */
type Slot = { feature?: FeatureKey; text: (c: PlanConfig, all: Config) => string | null };

const line = (text: string): Slot => ({ text: () => text });
const gated = (feature: FeatureKey): Slot => ({ feature, text: () => LISTED[feature]!.bullet });

const contacts: Slot = {
  text: (c) => (c.contactLimit === null ? "Unlimited contacts" : `Up to ${c.contactLimit} contacts`),
};
const meetingHours: Slot = {
  feature: "meetings",
  text: (c) => (c.speech.meetingSeconds > 0 ? `${HOURS(c.speech.meetingSeconds)} of meeting transcription a month` : null),
};
const voiceHours: Slot = {
  text: (c) => (c.speech.shortformSeconds > 0 ? `${HOURS(c.speech.shortformSeconds)} of voice notes a month` : null),
};
const includedAi: Slot = {
  text: (c) => (c.features.hostedAi && c.monthlyCredits ? `AI included: ${c.monthlyCredits} credits a month` : "AI with a key you bring"),
};
/** "Everything in X", true only while this plan has every listed feature X has. */
const everythingIn = (base: Plan, suffix = ""): Slot => ({
  text: (c, all) => {
    const missing = LISTED_KEYS.filter((f) => all[base].features[f] && !c.features[f]).map((f) => LISTED[f]!.except);
    const uncapped = suffix && c.contactLimit === null ? suffix : "";
    return `Everything in ${base === "free" ? "the Free Plan" : PLAN_LABELS[base]}${uncapped}${missing.length ? `, except ${missing.join(", ")}` : ""}`;
  },
});

/**
 * Each plan's list as written, slot by slot. `planCopy` drops a gated slot the plan has lost,
 * and appends a bullet for each listed feature the plan has gained (one its base — the plan
 * its "Everything in" names — does not already cover).
 */
const TEMPLATES: Record<Plan, { base?: Plan; slots: Slot[] }> = {
  free: {
    slots: [
      contacts,
      {
        text: (c) =>
          `Capture notes, chat with your network, and summaries: ${c.features.hostedAi ? c.monthlyCredits ?? 0 : 0} AI credits a month + ${FREE_STARTER_CREDITS} to start`,
      },
      line("Constellation map"),
      line("Reminders and follow-up feed"),
      line("Knowledge base"),
      line("LinkedIn import and export anytime"),
      line("Claude and ChatGPT connector"),
      { text: (c) => (c.features.extraConnections ? LISTED.extraConnections!.bullet : "One Google or Microsoft account") },
      voiceHours,
    ],
  },
  orbit: {
    base: "free",
    slots: [
      everythingIn("free", ", uncapped"),
      contacts,
      includedAi,
      gated("creditPacks"),
      gated("recruiters"),
      gated("extraConnections"),
      gated("sync"),
      meetingHours,
      voiceHours,
    ],
  },
  max: {
    base: "orbit",
    slots: [
      everythingIn("orbit"),
      { text: (c, all) => (c.contactLimit === all.orbit.contactLimit ? null : contacts.text(c, all)) },
      includedAi,
      meetingHours,
      voiceHours,
      gated("api"),
    ],
  },
  lifetime: {
    slots: [
      contacts,
      {
        text: (c) =>
          c.features.recruiters && c.features.extraConnections
            ? "Recruiter tracking, with Google and Microsoft together"
            : c.features.recruiters
              ? LISTED.recruiters!.bullet
              : c.features.extraConnections
                ? LISTED.extraConnections!.bullet
                : null,
      },
      meetingHours,
      voiceHours,
      gated("api"),
    ],
  },
};

/** Listed features a template already speaks for, gated or not. */
const TEMPLATE_COVERS: Record<Plan, FeatureKey[]> = {
  free: ["extraConnections"],
  orbit: ["creditPacks", "recruiters", "extraConnections", "sync", "meetings"],
  max: ["meetings", "api"],
  lifetime: ["recruiters", "extraConnections", "meetings", "api"],
};

/**
 * `plan`'s bullets under `config`. A listed feature appears on a plan iff the plan has it; the
 * numbers are the config's. Lines with no feature behind them (the map, reminders, the
 * knowledge base…) are general product capabilities and stay as written.
 */
export function planFeatures(plan: Plan, config: Config = PLAN_CONFIG): string[] {
  const c = config[plan];
  const { base, slots } = TEMPLATES[plan];
  const out: string[] = [];
  for (const slot of slots) {
    if (slot.feature && !c.features[slot.feature]) continue;
    const text = slot.text(c, config);
    if (text) out.push(text);
  }
  for (const f of LISTED_KEYS) {
    if (!c.features[f] || TEMPLATE_COVERS[plan].includes(f)) continue;
    // Covered by "Everything in <base>", or (no base) already true of the code default, which
    // the template was written against — Free can buy packs and Lifetime syncs without saying so.
    if (base ? config[base].features[f] : PLAN_CONFIG[plan].features[f]) continue;
    out.push(LISTED[f]!.bullet);
  }
  return out;
}

const STATIC: Record<Plan, Omit<PlanCopy, "features" | "caveat"> & { caveat: (c: PlanConfig) => string }> = {
  free: {
    id: "free",
    name: "Free Plan",
    tagline: "The whole core product, for a network you can hold in your head.",
    price: samePrice({ amount: "$0", cadence: "forever" }),
    caveat: () => "Add your own AI key any time for no limit.",
  },
  orbit: {
    id: "orbit",
    name: "Orbit Pro",
    tagline: "For a network worth more than the price of a coffee.",
    price: prices("orbit"),
    caveat: () => "Prefer your own AI key? Add it any time; calls on it never use credits.",
  },
  max: {
    id: "max",
    name: "Orbit Max",
    tagline: "For the people whose network is the job.",
    price: prices("max"),
    caveat: () => "Prefer your own AI key? Add it any time; calls on it never use credits.",
  },
  lifetime: {
    // Not sold: granted by Orbit. Described for the plan card and the celebration only.
    id: "lifetime",
    name: "Orbit Lifetime",
    tagline: "Yours for as long as Orbit exists.",
    price: samePrice({ amount: "Granted", cadence: "by Orbit" }),
    caveat: (c) =>
      `${c.monthlyCredits ?? 0} AI credits a month are included.${c.features.creditPacks ? "" : " Credit packs aren’t available on this plan."}`,
  },
};

/**
 * How `plan` is described under `config`. PURE: pass the effective table
 * (`getEffectivePlanConfig()` on the server, `useViewerPlan().planConfig` in the app shell)
 * so an admin's plan rule reaches every card; the default is the code table.
 */
export function planCopy(plan: Plan, config: Config = PLAN_CONFIG): PlanCopy {
  const { caveat, ...rest } = STATIC[plan] ?? STATIC.free;
  return { ...rest, features: planFeatures(rest.id, config), caveat: caveat(config[rest.id]) };
}

/** The plans on sale under `config`, in the order the pricing page shows them. */
export function publicPlanCopy(config: Config = PLAN_CONFIG): PlanCopy[] {
  return (["free", "orbit", "max"] as const).map((p) => planCopy(p, config));
}

/** Every plan's copy under the CODE defaults — the fallback when no effective config is at hand. */
export const PLAN_COPY: PlanCopy[] = PLANS.map((p) => planCopy(p));
export const PUBLIC_PLAN_COPY: PlanCopy[] = publicPlanCopy();

/** One comparison-table cell: a tick, a dash, or a value. */
export type ComparisonCell = boolean | string;
export type ComparisonColumn = "free" | PurchasablePlan;
export const COMPARISON_COLUMNS: ComparisonColumn[] = ["free", "orbit", "max"];

/**
 * The pricing page's comparison rows under `config` and the operator's page tier rules
 * (`getTierRules()`: page key → the plans that may open it; no entry = every plan). A row tied
 * to a page shows a dash for a plan the page is locked away from; a row tied to a feature
 * follows the feature. Export and the Claude/ChatGPT connector have no gate at all.
 */
export function comparisonRows(
  config: Config = PLAN_CONFIG,
  tierRules: ReadonlyMap<string, readonly Plan[]> = new Map()
): Array<{ label: string; cells: [ComparisonCell, ComparisonCell, ComparisonCell] }> {
  const each = <T,>(fn: (plan: ComparisonColumn) => T): [T, T, T] => [fn("free"), fn("orbit"), fn("max")];
  const open = (page: string | undefined, plan: Plan) => !page || (tierRules.get(page)?.includes(plan) ?? true);
  const page = (key: string) => each((plan) => open(key, plan));
  const feature = (key: FeatureKey, pageKey?: string) => each((plan) => config[plan].features[key] && open(pageKey, plan));
  const hours = (plan: ComparisonColumn, seconds: number) => (seconds === 0 ? false : `${HOURS(seconds)} a month`);
  return [
    {
      label: "Contacts",
      cells: each((plan) => (config[plan].contactLimit === null ? "Unlimited" : `Up to ${config[plan].contactLimit}`)),
    },
    {
      label: "AI for capture, chat and summaries",
      cells: each((plan) => {
        const credits = config[plan].features.hostedAi ? config[plan].monthlyCredits : null;
        return credits ? `Included: ${credits} credits a month${plan === "free" ? ` + ${FREE_STARTER_CREDITS} to start` : ""}` : "Bring a key";
      }),
    },
    { label: `Credit packs (${CREDIT_PACK_PRICE_LABEL} = ${CREDIT_PACK_CREDITS} credits)`, cells: feature("creditPacks") },
    { label: "Capture with AI extraction", cells: page("page.capture") },
    { label: "Chat with your network", cells: page("page.chat") },
    { label: "Constellation map", cells: page("page.graph") },
    { label: "LinkedIn import", cells: page("page.imports") },
    { label: "Reminders and follow-up feed", cells: page("page.reminders") },
    { label: "Knowledge base", cells: page("page.knowledge") },
    { label: "Export your data", cells: [true, true, true] },
    // Free on every plan: it is how most people will first see what Orbit is for.
    { label: "Use from Claude and ChatGPT", cells: [true, true, true] },
    {
      label: "Google and Microsoft accounts (mail, contacts, calendar)",
      cells: each((plan) => (config[plan].googleMicrosoftConnections === 1 ? "One" : "Both")),
    },
    { label: "Recruiter tracking", cells: feature("recruiters", "page.recruiters") },
    { label: "Calendar subscriptions", cells: feature("sync") },
    {
      label: "Meeting transcription",
      cells: each((plan) =>
        config[plan].features.meetings && open("page.meetings", plan) ? hours(plan, config[plan].speech.meetingSeconds) : false
      ),
    },
    { label: "Voice notes and chat mic", cells: each((plan) => hours(plan, config[plan].speech.shortformSeconds)) },
    { label: "REST API and webhooks", cells: feature("api") },
  ];
}

/**
 * Founding pricing for an eligible account, always stated with its full terms — e.g.
 * "$6.99/month for your first 3 months, then $8.99/month". Only ever rendered for a
 * signed-in account whose `founding_eligible` is set and not yet redeemed. Monthly billing
 * only: an annual plan is already two months free.
 */
export function foundingPriceTerms(plan: PurchasablePlan): string {
  const list = PLAN_CONFIG[plan].monthlyPriceCents ?? 0;
  const founding = list - FOUNDING_AMOUNT_OFF_CENTS[plan];
  return `${formatPlanPrice(founding)}/month for your first ${FOUNDING_MONTHS} months, then ${formatPlanPrice(list)}/month`;
}

/**
 * The plan card's line when contacts are uncapped. A demo account's limits are lifted by
 * `getEntitlements`, not bought, so it says so — otherwise a free plan on localhost read
 * "Unlimited contacts" right beside its own "Up to 500 contacts".
 */
export function unlimitedContactsLine(used: number, demo: DemoAccountReason | null): string {
  if (demo === "localhost") return `Demo account — plan limits lifted on localhost. ${used} in your orbit.`;
  if (demo === "showcase") return `Showcase account — plan limits lifted. ${used} in your orbit.`;
  return `Unlimited contacts — ${used} in your orbit.`;
}
