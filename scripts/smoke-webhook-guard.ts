/**
 * Asserts that a signature-invalid webhook delivery is recorded ONCE per hour per source,
 * not once per request.
 *
 * The rejection path of every inbound webhook writes a `webhook_deliveries` row before any
 * authentication has happened — that is what makes "an event arrived and nothing happened"
 * recordable at all. It is also what let anyone POST garbage at `/api/webhooks/*` and grow
 * the table a row per request. The routes now guard that write with the same once-per-window
 * latch `error_events` uses, so the ledger still says "signatures are failing" without
 * becoming a write amplifier. The Stripe route did not record rejections at all, which left
 * the ops sweep blind to a rolled Stripe secret; it does now.
 *
 * Run: npx tsx scripts/smoke-webhook-guard.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

// Force local PGlite — this repo's .env.local points DATABASE_URL at the shared remote DB,
// and dotenv only fills in unset vars, so the delete has to come after it.
delete process.env.DATABASE_URL;

// Real-looking secrets so each verifier reaches its "signature does not match" branch
// rather than its "not configured" branch. None talk to a network.
process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ=";
process.env.RESEND_WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ=";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_smoke_only_not_a_real_secret";
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../src/db";
import { webhookDeliveries } from "../src/db/schema";
import { POST as clerkPost } from "../src/app/api/webhooks/clerk/route";
import { POST as resendPost } from "../src/app/api/webhooks/resend/route";
import { POST as stripePost } from "../src/app/api/webhooks/stripe/route";

const STARTED = new Date();

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

type Post = (req: never) => Promise<Response>;
const call = (post: Post, req: Request) => post(req as never);

function svixGarbage(path: string, n: number) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": `smoke-guard-${n}`,
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,bm90LWEtcmVhbC1zaWduYXR1cmU=",
    },
    body: JSON.stringify({ type: "user.created", data: { id: "user_smoke" } }),
  });
}

function stripeGarbage() {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`,
    },
    body: JSON.stringify({ id: "evt_smoke", type: "checkout.session.completed" }),
  });
}

async function invalidRowsSince(source: string) {
  const db = await getDb();
  return db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.source, source),
        eq(webhookDeliveries.outcome, "invalid"),
        gte(webhookDeliveries.createdAt, STARTED)
      )
    );
}

async function main() {
  console.log("Webhook rejection ledger is throttled per source...");

  const clerkStatuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    clerkStatuses.push((await call(clerkPost as Post, svixGarbage("/api/webhooks/clerk", i))).status);
  }
  check("clerk rejects every garbage delivery", clerkStatuses.every((s) => s === 400), clerkStatuses.join(","));
  const clerkRows = await invalidRowsSince("clerk");
  check("clerk records exactly one invalid row for three rejections", clerkRows.length === 1, `got ${clerkRows.length}`);

  const resendStatuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    resendStatuses.push((await call(resendPost as Post, svixGarbage("/api/webhooks/resend", i))).status);
  }
  check("resend rejects every garbage delivery", resendStatuses.every((s) => s === 400), resendStatuses.join(","));
  const resendRows = await invalidRowsSince("resend");
  check("resend records exactly one invalid row for three rejections", resendRows.length === 1, `got ${resendRows.length}`);

  const stripeStatuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    stripeStatuses.push((await call(stripePost as Post, stripeGarbage())).status);
  }
  check("stripe rejects every garbage delivery", stripeStatuses.every((s) => s === 400), stripeStatuses.join(","));
  const stripeRows = await invalidRowsSince("stripe");
  check("stripe records exactly one invalid row for three rejections", stripeRows.length === 1, `got ${stripeRows.length}`);

  console.log("\nAll webhook-guard checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
