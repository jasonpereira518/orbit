/**
 * A Stripe event Orbit cannot attribute to an account leaves an error_events row the ops
 * sweep reads, not just a log line that expires in an hour.
 *
 * Run: npx tsx scripts/smoke-stripe-unattributed.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const TEST_SECRET = "whsec_test_smoke_unattributed_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents } from "../src/db/schema";
import { ERROR_SOURCES } from "../src/lib/error-events";
import { POST } from "../src/app/api/webhooks/stripe/route";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const EVENT_ID = "evt_smoke_unattributed_1";

function signed(event: unknown) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

run(async () => {
  const db = await getDb();
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));

  // No client_reference_id, no user metadata, and a customer id no account has.
  const res = await POST(signed({
    id: EVENT_ID,
    object: "event",
    type: "checkout.session.completed",
    created: 1_700_000_000,
    data: { object: { id: "cs_smoke_unattributed", object: "checkout.session", payment_status: "paid",
      customer: "cus_smoke_nobody", customer_details: { email: "buyer@example.test" }, metadata: {} } },
  }) as unknown as Parameters<typeof POST>[0]);
  check("the webhook still answers 200 (a retry would not help)", res.status === 200, String(res.status));

  const rows = await db.select().from(errorEvents).where(and(
    eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed), eq(errorEvents.kind, "checkout.session.completed")));
  check("one stripe.unattributed row, kind = event type", rows.length === 1, JSON.stringify(rows));
  const ctx = (rows[0]?.context ?? {}) as Record<string, unknown>;
  check("context carries the event and session ids", ctx.eventId === EVENT_ID && ctx.resourceId === "cs_smoke_unattributed", JSON.stringify(ctx));
  check("and nothing from the payload itself", !JSON.stringify(rows[0]).includes("buyer@example.test"));

  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll stripe-unattributed checks passed.");
});
