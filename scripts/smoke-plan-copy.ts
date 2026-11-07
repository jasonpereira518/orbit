/**
 * Plan copy follows the EFFECTIVE plan table: an admin's plan rule (/admin/product/plans)
 * reaches the plan bullets, the pricing comparison, the paywall refusal and the credit email,
 * and with no rules every one of them reads exactly as the hand-written copy did.
 *
 * Imports modules that reach `@/db` (entitlements, credit notices) but never queries; the
 * preamble keeps it on PGlite all the same.
 *
 * Run: npx tsx scripts/smoke-plan-copy.ts
 */
import "./smoke/_env";

import { checker } from "./smoke/check";
import { COMPARISON_COLUMNS, PLAN_COPY, comparisonRows, planCopy, publicPlanCopy } from "../src/lib/plan-copy";
import { featureDenial } from "../src/lib/entitlements";
import { buildCreditEmail } from "../src/lib/credits/notices";
import { PLAN_CONFIG, availableOn, extraConnectionDenial } from "../src/lib/plans/plan-config";
import { applyPlanOverrides, describeOverrides, featureRuleRow, limitRuleRow, parsePlanRules } from "../src/lib/plans/plan-overrides";
import { pricingFaq } from "../src/components/pricing/pricing-faq";

const t = checker();

// --- No overrides: the copy as it was written by hand -------------------------------------
console.log("\ncode defaults");
const DEFAULT_FEATURES = {
  free: [
    "Up to 500 contacts",
    "Capture notes, chat with your network, and summaries: 50 AI credits a month + 25 to start",
    "Constellation map",
    "Reminders and follow-up feed",
    "Knowledge base",
    "LinkedIn import and export anytime",
    "Claude and ChatGPT connector",
    "One Google or Microsoft account",
    "90 minutes of voice notes a month",
  ],
  orbit: [
    "Everything in the Free Plan, uncapped",
    "Unlimited contacts",
    "AI included: 300 credits a month",
    "Top up with $5 packs of 250 credits",
    "Recruiter tracking",
    "Connect both Google and Microsoft",
    "Calendar subscriptions",
    "8 hours of meeting transcription a month",
    "8 hours of voice notes a month",
  ],
  max: [
    "Everything in Orbit Pro",
    "AI included: 650 credits a month",
    "15 hours of meeting transcription a month",
    "15 hours of voice notes a month",
    "REST API and webhooks",
  ],
  lifetime: [
    "Unlimited contacts",
    "Recruiter tracking, with Google and Microsoft together",
    "15 hours of meeting transcription a month",
    "15 hours of voice notes a month",
    "REST API and webhooks",
  ],
};
for (const copy of PLAN_COPY) {
  const want = DEFAULT_FEATURES[copy.id];
  t.check(`${copy.id}: default bullets are the hand-written ones`, JSON.stringify(copy.features) === JSON.stringify(want), JSON.stringify(copy.features));
}
t.check("Lifetime's caveat still says packs are not sold", planCopy("lifetime").caveat === "150 AI credits a month are included. Credit packs aren’t available on this plan.");
t.check("planCopy with the code table equals the default", JSON.stringify(publicPlanCopy(PLAN_CONFIG)) === JSON.stringify(PLAN_COPY.slice(0, 3)));
t.check("default denials name the plans as before",
  featureDenial("recruiters") === "Recruiter tracking is available on Orbit Pro and Orbit Max." &&
    featureDenial("api") === "The Orbit API and webhooks are available on Orbit Max. Claude and ChatGPT connect on any plan, with no key." &&
    featureDenial("extension") === "The Orbit extension is available on every plan.");
t.check("default extra-connection refusal unchanged", extraConnectionDenial() === "The Free Plan includes one Google or Microsoft account. Connecting both is available on Orbit Pro and Orbit Max.");
const defaultRows = comparisonRows();
t.check("default comparison: the page rows are ticks everywhere", defaultRows.filter((r) => r.label === "Constellation map" || r.label === "Knowledge base").every((r) => r.cells.every((c) => c === true)));
t.check("default comparison: API on Max only", JSON.stringify(defaultRows.find((r) => r.label === "REST API and webhooks")!.cells) === "[false,false,true]");
const notice = { level: 80 as const, plan: "orbit" as const, grantedCredits: 300, usedCredits: 250, packCredits: 0, resetsAt: new Date("2026-12-01T00:00:00Z") };
t.check("default Pro credit email offers a pack and Max",
  buildCreditEmail(notice, "https://x/u").text.includes("you can add a $5 pack of 250 credits, move to Orbit Max, which includes 650 credits a month, or switch to your own AI key"));
t.check("no overrides, nothing for the legal reminder", describeOverrides(parsePlanRules([]), PLAN_CONFIG).length === 0);

// --- Recruiters to Free, the API off Max, Free capped at 1,000 ----------------------------
console.log("\nwith overrides");
const rules = parsePlanRules([
  featureRuleRow("recruiters", ["free", "orbit", "max", "lifetime"]),
  featureRuleRow("api", ["lifetime"]),
  limitRuleRow("free", "contactLimit", 1000),
]);
const config = applyPlanOverrides(PLAN_CONFIG, rules);
const free = planCopy("free", config).features;
const pro = planCopy("orbit", config).features;
const max = planCopy("max", config).features;
t.check("Free: the new cap", free[0] === "Up to 1000 contacts", JSON.stringify(free));
t.check("Free: gains Recruiter tracking", free.includes("Recruiter tracking"), JSON.stringify(free));
t.check("Pro: still Recruiter tracking, still 'Everything in the Free Plan, uncapped'", pro.includes("Recruiter tracking") && pro[0] === "Everything in the Free Plan, uncapped", JSON.stringify(pro));
t.check("Max: no REST API line", !max.some((f) => /REST API/.test(f)), JSON.stringify(max));
t.check("Max: 'Everything in Orbit Pro' stays true", max[0] === "Everything in Orbit Pro", JSON.stringify(max));
t.check("Lifetime keeps the API", planCopy("lifetime", config).features.includes("REST API and webhooks"));

const rows = comparisonRows(config);
const cells = (label: string) => JSON.stringify(rows.find((r) => r.label === label)!.cells);
t.check("comparison: contacts", cells("Contacts") === '["Up to 1000","Unlimited","Unlimited"]', cells("Contacts"));
t.check("comparison: recruiters on every column", cells("Recruiter tracking") === "[true,true,true]", cells("Recruiter tracking"));
t.check("comparison: no column has the API", cells("REST API and webhooks") === "[false,false,false]", cells("REST API and webhooks"));
const locked = comparisonRows(config, new Map([["page.graph", ["orbit", "max", "lifetime"]]]));
t.check("comparison: a page locked away from Free shows a dash there", JSON.stringify(locked.find((r) => r.label === "Constellation map")!.cells) === "[false,true,true]");
t.check("comparison: ungated rows stay ticks", JSON.stringify(locked.find((r) => r.label === "Export your data")!.cells) === "[true,true,true]");
t.check("comparison has a cell per column", rows.every((r) => r.cells.length === COMPARISON_COLUMNS.length));

t.check("denial: recruiters on every plan", featureDenial("recruiters", config) === "Recruiter tracking is available on every plan.", featureDenial("recruiters", config));
t.check("denial: the API is on no plan on sale", /available on no plan at the moment/.test(featureDenial("api", config)), featureDenial("api", config));
t.check("availableOn: contacts uncapped on Pro and Max", availableOn("contacts", config) === "Orbit Pro and Orbit Max");

const faq = pricingFaq(config).map((f) => `${f.q} ${f.a}`).join("\n");
t.check("FAQ: the cap is 1000", faq.includes("What happens when I reach 1000 contacts?"));
t.check("FAQ: Max no longer claims the API", !faq.includes("Max also includes the REST API"));

const maxOff = applyPlanOverrides(PLAN_CONFIG, parsePlanRules([limitRuleRow("max", "monthlyCredits", 900)]));
t.check("credit email: Max's allowance follows its limit", buildCreditEmail(notice, "https://x/u", maxOff).text.includes("move to Orbit Max, which includes 900 credits a month"));
const noPacks = applyPlanOverrides(PLAN_CONFIG, parsePlanRules([featureRuleRow("creditPacks", ["free"])]));
const email = buildCreditEmail(notice, "https://x/u", noPacks).text;
t.check("credit email: no pack offered when Pro cannot buy one", !email.includes("$5 pack") && email.includes("move to Orbit Max"), email);

const lines = describeOverrides(rules, PLAN_CONFIG);
t.check("legal reminder lists every override", lines.length === 3 && lines.some((l) => l.startsWith("recruiters:")) && lines.includes("Free contactLimit: 1000 (default 500)"), JSON.stringify(lines));

t.done("smoke-plan-copy");
