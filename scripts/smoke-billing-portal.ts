/**
 * A subscriber can open Stripe's customer portal to cancel or change billing, and nobody
 * else gets a portal session for a customer that is not theirs.
 *
 * Run: npx tsx scripts/smoke-billing-portal.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { BILLING_PORTAL_COPY, createBillingPortalUrl } from "../src/lib/billing-portal";

const SUBSCRIBER = "smoke-portal-subscriber";
const LIFETIME = "smoke-portal-lifetime";
const FREE = "smoke-portal-free";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

run(async () => {
  const db = await getDb();
  for (const id of [SUBSCRIBER, LIFETIME, FREE]) await ensureUserSettings(id);
  const future = new Date(Date.now() + 20 * 86_400_000);
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_sub", subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: future })
    .where(eq(userSettings.userId, SUBSCRIBER));
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_life", lifetimePurchasedAt: new Date() })
    .where(eq(userSettings.userId, LIFETIME));

  const calls: Array<{ customer: string; return_url: string }> = [];
  const createSession = async (args: { customer: string; return_url: string }) => {
    calls.push(args);
    return { url: `https://billing.stripe.test/session/${args.customer}` };
  };

  console.log("A subscriber gets a portal session for their own customer");
  const sub = await createBillingPortalUrl(SUBSCRIBER, { createSession });
  check("returns the session url", "url" in sub && sub.url === "https://billing.stripe.test/session/cus_smoke_sub", JSON.stringify(sub));
  check("for their own customer id", calls[0]?.customer === "cus_smoke_sub");
  check("returning to the plan card", /\/settings#settings-plan$/.test(calls[0]?.return_url ?? ""), calls[0]?.return_url);

  console.log("\nNobody else gets one");
  const life = await createBillingPortalUrl(LIFETIME, { createSession });
  check("a Lifetime buyer (no subscription) is told there is nothing to manage",
    "error" in life && life.error === BILLING_PORTAL_COPY.noSubscription, JSON.stringify(life));
  const free = await createBillingPortalUrl(FREE, { createSession });
  check("a free account is told the same", "error" in free && free.error === BILLING_PORTAL_COPY.noSubscription);
  check("neither reached Stripe", calls.length === 1, String(calls.length));

  console.log("\nStripe trouble is a sentence, not a stack trace");
  const broken = await createBillingPortalUrl(SUBSCRIBER, {
    createSession: async () => { throw new Error("No configuration provided; set your default configuration in the dashboard"); },
  });
  check("a Stripe error returns the unavailable copy",
    "error" in broken && broken.error === BILLING_PORTAL_COPY.unavailable, JSON.stringify(broken));
  const noUrl = await createBillingPortalUrl(SUBSCRIBER, { createSession: async () => ({ url: null }) });
  check("a session without a url returns the unavailable copy", "error" in noUrl && noUrl.error === BILLING_PORTAL_COPY.unavailable);

  check("copy follows the house voice",
    !/failed|Could not|\.$/.test(BILLING_PORTAL_COPY.noSubscription + BILLING_PORTAL_COPY.unavailable));

  if (failures > 0) throw new Error(`${failures} billing-portal check(s) failed`);
  console.log("\nAll billing-portal checks passed.");
});
