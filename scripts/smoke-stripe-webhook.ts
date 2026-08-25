/**
 * Drives the real Stripe webhook route with real signatures, using the SDK's
 * `generateTestHeaderString`. No network, no Stripe account, no live keys.
 *
 * Covers the things most likely to break silently: signature verification, attribution
 * via client_reference_id, the metadata guard, unpaid sessions, and idempotency.
 *
 * Run: npx tsx scripts/smoke-stripe-webhook.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const TEST_SECRET = "whsec_test_smoke_only_not_a_real_secret";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { getEntitlements } from "../src/lib/entitlements";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
} from "../src/lib/stripe";
import { POST } from "../src/app/api/webhooks/stripe/route";

const USER = "smoke-stripe-user";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

function sessionEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt_smoke_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_smoke_1",
        object: "checkout.session",
        client_reference_id: USER,
        payment_status: "paid",
        customer: "cus_smoke_1",
        metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
        ...over,
      },
    },
  };
}

/** Builds a request the route handler can consume, signed the way Stripe signs. */
function signedRequest(event: unknown, secret = TEST_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

// The route is typed for NextRequest but only uses headers/text, which Request provides.
const post = (req: Request) =>
  POST(req as unknown as Parameters<typeof POST>[0]);

async function lifetimeAt() {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, USER),
  });
  return row?.lifetimePurchasedAt ?? null;
}

async function reset() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function main() {
  console.log("Stripe webhook smoke test (pglite)…\n");
  await reset();

  console.log("rejects what it should");
  const noSig = await post(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: "{}",
    })
  );
  check("missing signature -> 400", noSig.status === 400, String(noSig.status));

  const badSig = await post(signedRequest(sessionEvent(), "whsec_wrong_secret"));
  check("wrong secret -> 400", badSig.status === 400, String(badSig.status));

  const tampered = new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "stripe-signature": stripe.webhooks.generateTestHeaderString({
        payload: JSON.stringify(sessionEvent()),
        secret: TEST_SECRET,
      }),
    },
    // Same signature, different body — exactly what a raw-body mistake would let through.
    body: JSON.stringify(sessionEvent({ client_reference_id: "attacker" })),
  });
  const tamperedRes = await post(tampered);
  check("tampered body -> 400", tamperedRes.status === 400, String(tamperedRes.status));
  check("nothing granted by rejected calls", (await lifetimeAt()) === null);

  console.log("\nignores what it should");
  const wrongProduct = await post(
    signedRequest(sessionEvent({ metadata: { [LIFETIME_METADATA_KEY]: "something-else" } }))
  );
  check("other product -> 200 but no grant", wrongProduct.status === 200 && (await lifetimeAt()) === null);

  const unpaid = await post(signedRequest(sessionEvent({ payment_status: "unpaid" })));
  check("unpaid session -> no grant", unpaid.status === 200 && (await lifetimeAt()) === null);

  const noUser = await post(signedRequest(sessionEvent({ client_reference_id: null })));
  check("no client_reference_id -> no grant", noUser.status === 200 && (await lifetimeAt()) === null);

  console.log("\ngrants on a real purchase");
  const ok = await post(signedRequest(sessionEvent()));
  check("valid event -> 200", ok.status === 200, String(ok.status));

  const granted = await lifetimeAt();
  check("lifetime_purchased_at written", granted !== null);

  const ent = await getEntitlements(USER);
  check("entitlements resolve to lifetime", ent.plan === "lifetime", ent.plan);
  check("hosted sending unlocked on lifetime", ent.canUseHostedSending === true);
  check("hosted enrichment still gated on lifetime", ent.canUseHostedEnrichment === false);
  check("contacts uncapped", ent.contactLimit === null);

  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, USER),
  });
  check("stripe customer id stored", row?.stripeCustomerId === "cus_smoke_1", String(row?.stripeCustomerId));

  console.log("\nsurvives Stripe's retries");
  await post(signedRequest(sessionEvent()));
  await post(signedRequest({ ...sessionEvent(), type: "checkout.session.async_payment_succeeded" }));
  const after = await lifetimeAt();
  check(
    "repeat deliveries keep the first timestamp",
    after?.getTime() === granted?.getTime(),
    `${granted?.toISOString()} -> ${after?.toISOString()}`
  );

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nAll Stripe webhook checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
