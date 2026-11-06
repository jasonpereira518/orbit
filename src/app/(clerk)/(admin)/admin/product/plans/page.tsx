import Link from "next/link";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { AdminPanel } from "@/components/admin/primitives";
import { PlanFeatureRules, PlanLimitRules } from "@/components/admin/plan-rules-panel";
import { resolvePlan } from "@/lib/entitlements";
import { PLANS, PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";
import { getEffectivePlanConfig, getPlanRules } from "@/lib/plans/plan-rules";
import { describeOverrides } from "@/lib/plans/plan-overrides";
import { ProductHeader } from "../product-header";

export const metadata = { title: "Admin · Product · Plans" };

/**
 * Accounts paying for each plan right now (a live subscription, or Lifetime bought or granted
 * — not comps, not Free). What the console warns about before a feature is taken off a plan.
 * ponytail: one scan of user_settings per render; fine at today's account count.
 */
async function payingAccountsByPlan(): Promise<Record<Plan, number>> {
  const db = await getDb();
  const rows = await db
    .select({
      compedPlan: userSettings.compedPlan,
      lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
      subscriptionPlan: userSettings.subscriptionPlan,
      subscriptionStatus: userSettings.subscriptionStatus,
      subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
    })
    .from(userSettings);
  const counts = Object.fromEntries(PLANS.map((p) => [p, 0])) as Record<Plan, number>;
  for (const row of rows) {
    const { plan, source } = resolvePlan(row);
    if (source === "subscription" || source === "lifetime") counts[plan] += 1;
  }
  return counts;
}

/**
 * Who gets what: every plan feature and numeric limit, editable per plan at runtime. Stored as
 * overrides of the code table (`PLAN_CONFIG`), so "Default" means the code's own answer.
 */
export default async function AdminProductPlansPage() {
  const [config, rules, paying] = await Promise.all([
    getEffectivePlanConfig(),
    getPlanRules(),
    payingAccountsByPlan(),
  ]);
  const changed = describeOverrides(rules, PLAN_CONFIG);

  return (
    <>
      <ProductHeader />
      <p className="mb-4 text-xs text-muted-foreground">
        Changes apply to every account within about 15 seconds. Taking something off a plan keeps
        everyone&apos;s data and stops new use, the same as a downgrade. Admins and demo accounts
        are exempt. Which plans can open each page is on the{" "}
        <Link href="/admin/product" className="underline underline-offset-2">
          Pages tab
        </Link>
        .
      </p>
      {changed.length > 0 && (
        // Pricing, plan cards, upgrade prompts and emails follow these rules on their own; the
        // legal pages are hash-locked copy and never do.
        <div role="note" className="mb-4 rounded-lg border border-warning-border bg-warning-surface p-3 text-xs">
          <p className="font-medium text-foreground">
            {changed.length === 1 ? "1 rule differs" : `${changed.length} rules differ`} from the code defaults. The{" "}
            <Link href="/terms" className="underline underline-offset-2">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline underline-offset-2">
              Privacy
            </Link>{" "}
            pages are not updated automatically — check whether they describe any of these:
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {changed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <AdminPanel title="Features" className="mb-6">
        <PlanFeatureRules config={config} defaults={PLAN_CONFIG} overridden={Object.keys(rules.features)} paying={paying} />
      </AdminPanel>
      <AdminPanel title="Limits">
        <PlanLimitRules config={config} defaults={PLAN_CONFIG} rules={rules} />
      </AdminPanel>
    </>
  );
}
