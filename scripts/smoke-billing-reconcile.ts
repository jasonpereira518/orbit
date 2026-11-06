/**
 * Pins the Stripe-vs-database comparison: every mismatch kind, and that agreement is silent.
 * Pure: no Stripe client, no database. Run: npx tsx scripts/smoke-billing-reconcile.ts
 */
import { compareStripeToDb, type DbSubView, type StripeSubView } from "../src/lib/billing-reconcile";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const stripe = (o: Partial<StripeSubView> & { id: string }): StripeSubView => ({
  customerId: `cus_${o.id}`, userId: `u_${o.id}`, status: "active", plan: "orbit", monthlyCents: 899, ...o,
});
const db = (o: Partial<DbSubView> & { userId: string }): DbSubView => ({
  stripeCustomerId: `cus_${o.userId.slice(2)}`, subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionMonthlyCents: 899, ...o,
});

const agree = compareStripeToDb([stripe({ id: "a" })], [db({ userId: "u_a" })]);
check("agreement is silent", agree.mismatches.length === 0 && agree.checked === 1, JSON.stringify(agree.byKind));

const missingDb = compareStripeToDb([stripe({ id: "a" })], []);
check("a subscription Stripe bills that the database lacks", missingDb.byKind.in_stripe_not_in_db === 1);

const missingStripe = compareStripeToDb([], [db({ userId: "u_a" })]);
check("a database subscriber Stripe does not bill", missingStripe.byKind.in_db_not_in_stripe === 1);

check("a canceled database row with no Stripe sub is fine", compareStripeToDb([], [db({ userId: "u_a", subscriptionStatus: "canceled" })]).mismatches.length === 0);
check("a free account with a customer id is fine", compareStripeToDb([], [db({ userId: "u_a", subscriptionPlan: null, subscriptionStatus: null })]).mismatches.length === 0);

check("a plan difference", compareStripeToDb([stripe({ id: "a", plan: "max" })], [db({ userId: "u_a" })]).byKind.plan_differs === 1);
check("an amount difference", compareStripeToDb([stripe({ id: "a", monthlyCents: 1999 })], [db({ userId: "u_a" })]).byKind.amount_differs === 1);
check("an unknown amount on either side is not a difference", compareStripeToDb([stripe({ id: "a", monthlyCents: null })], [db({ userId: "u_a" })]).mismatches.length === 0 && compareStripeToDb([stripe({ id: "a" })], [db({ userId: "u_a", subscriptionMonthlyCents: null })]).mismatches.length === 0);
check("Stripe live but the database says canceled", compareStripeToDb([stripe({ id: "a" })], [db({ userId: "u_a", subscriptionStatus: "canceled" })]).byKind.status_differs === 1);
check("past_due and trialing are live", compareStripeToDb([stripe({ id: "a", status: "trialing" }), stripe({ id: "b", status: "past_due" })], [db({ userId: "u_a" }), db({ userId: "u_b", subscriptionStatus: "past_due" })]).mismatches.length === 0);
check("a Stripe subscription that is not live is ignored", compareStripeToDb([stripe({ id: "a", status: "canceled" })], []).mismatches.length === 0);
check("falls back to the customer id when metadata is missing", compareStripeToDb([stripe({ id: "a", userId: null })], [db({ userId: "u_a" })]).mismatches.length === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll billing-reconcile checks passed.");
