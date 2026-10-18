/**
 * Closing an account, from every door: whichever path ends an account, the Stripe
 * subscription is cancelled (or queued for retry) BEFORE the settings row — the only link to
 * it — is purged, and the person's waitlist footprint goes with them.
 *
 * Before this, only Settings → Delete account cancelled anything. A signed Clerk
 * `user.deleted` event purged everything including `stripe_customer_id` and made no Stripe
 * call at all (found by `privacy/probe-account-deletion.ts`), and the waitlist row — email,
 * name, referral graph — survived every deletion because the table has no `user_id`.
 *
 * Covers: the real Clerk webhook route with a correctly signed event; the orphan sweep; a
 * Stripe failure (queued, erasure still completes, hourly retry drains it); and a full
 * "Delete data" that keeps the account, which must cancel nothing and keep the waitlist row.
 *
 * Run: npx tsx scripts/smoke-account-closure.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { getDb, rowsOf } from "../src/db";
import {
  billingCancellationQueue,
  broadcastRecipients,
  broadcasts,
  interestListSignups,
  userSettings,
  waitlistPollVotes,
} from "../src/db/schema";
import { retryQueuedCancellations, setSubscriptionCancellerForTests } from "../src/lib/billing-cancel";
import { sweepOrphanedAccounts } from "../src/lib/clerk-orphan-sweep";
import { planPurgeSteps } from "../src/lib/data-categories";
import { purgeUserData } from "../src/lib/user-data";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Records each cancel, and whether the settings row still existed when it ran. */
function recordingCanceller(opts: { throws?: boolean } = {}) {
  const calls: Array<{ customerId: string; settingsPresent: boolean }> = [];
  setSubscriptionCancellerForTests(async (customerId) => {
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.stripeCustomerId, customerId) });
    calls.push({ customerId, settingsPresent: Boolean(row) });
    if (opts.throws) throw new Error("stripe is down");
  });
  return calls;
}

async function seedAccount(userId: string, opts: { customer?: string; waitlist?: boolean } = {}) {
  const db = await getDb();
  const email = `${userId}@Example.test`; // mixed case: the waitlist match is case-insensitive
  await db.insert(userSettings).values({
    userId,
    email: email.toLowerCase(),
    stripeCustomerId: opts.customer ?? null,
    lastActiveAt: new Date(Date.now() - 30 * 86_400_000),
    createdAt: new Date(Date.now() - 30 * 86_400_000),
  });
  if (!opts.waitlist) return null;
  const [signup] = await db
    .insert(interestListSignups)
    .values({ email, firstName: "Ada", lastName: "Lovelace", unsubscribeToken: `${userId}-unsub`, utmSource: "campus" })
    .returning();
  return signup;
}

async function count(table: string, where: ReturnType<typeof sql>): Promise<number> {
  const db = await getDb();
  return rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${where}`))[0]?.n ?? 0;
}

async function main() {
  const db = await getDb();

  console.log("The plan");
  const closing = planPurgeSteps(["tags", "preferences"], true, true);
  check("closing an account adds `account` just before `preferences`", closing.slice(-3).join(",") === "billing,account,preferences", closing.join(","));
  check("a full purge that keeps the account has no `account` step", !planPurgeSteps(["tags", "preferences"], true, false).includes("account"));

  // ------------------------------------------------------------ Clerk user.deleted webhook
  console.log("\nClerk user.deleted (real route, signed event)");
  const PAYER = "user_closure_payer";
  const signup = await seedAccount(PAYER, { customer: "cus_closure_payer", waitlist: true });
  const [friend] = await db
    .insert(interestListSignups)
    .values({ email: "friend@example.test", unsubscribeToken: "friend-unsub", referredById: signup!.id })
    .returning();
  const [bystander] = await db
    .insert(interestListSignups)
    .values({ email: "bystander@example.test", unsubscribeToken: "bystander-unsub" })
    .returning();
  await db.insert(waitlistPollVotes).values({ optionId: "o1", voterKey: `signup:${signup!.id}`, signupId: signup!.id });
  const [cast] = await db.insert(broadcasts).values({ subject: "News", body: "Hello", createdBy: "operator" }).returning();
  await db.insert(broadcastRecipients).values({ broadcastId: cast.id, signupId: signup!.id, email: signup!.email });
  await db.insert(broadcastRecipients).values({ broadcastId: cast.id, signupId: bystander.id, email: bystander.email });

  const calls = recordingCanceller();
  const secret = Buffer.from("smoke-account-closure-signing-secret!!").toString("base64");
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${secret}`;
  const { POST } = await import("../src/app/api/webhooks/clerk/route");
  const { NextRequest } = await import("next/server");
  const body = JSON.stringify({ type: "user.deleted", object: "event", data: { id: PAYER, deleted: true, object: "user" } });
  const at = new Date();
  const res = await POST(
    new NextRequest("http://localhost/api/webhooks/clerk", {
      method: "POST",
      body,
      headers: {
        "svix-id": "msg_smoke_account_closure",
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": new Webhook(secret).sign("msg_smoke_account_closure", at, body),
        "content-type": "application/json",
      },
    })
  );
  check("the webhook is accepted", res.status === 200, String(res.status));
  check("the subscription is cancelled exactly once", calls.length === 1 && calls[0].customerId === "cus_closure_payer", JSON.stringify(calls));
  check("...while the settings row (the link to Stripe) still existed", calls[0]?.settingsPresent === true);
  check("the settings row is gone afterwards", (await count("user_settings", sql`user_id = ${PAYER}`)) === 0);
  check("the waitlist row is gone (matched case-insensitively)", (await count("interest_list_signups", sql`id = ${signup!.id}`)) === 0);
  check("their poll vote is gone", (await count("waitlist_poll_votes", sql`signup_id = ${signup!.id}`)) === 0);
  check("their broadcast log is gone", (await count("broadcast_recipients", sql`signup_id = ${signup!.id}`)) === 0);
  check("the friend they referred stays, unlinked", (await count("interest_list_signups", sql`id = ${friend.id} AND referred_by_id IS NULL`)) === 1);
  check("someone else's waitlist row is untouched", (await count("interest_list_signups", sql`id = ${bystander.id}`)) === 1);
  check("someone else's broadcast log is untouched", (await count("broadcast_recipients", sql`signup_id = ${bystander.id}`)) === 1);
  check("nothing was queued", (await count("billing_cancellation_queue", sql`true`)) === 0);

  // ------------------------------------------------------------ Stripe down: queue and retry
  console.log("\nStripe fails during an orphan-sweep purge");
  const ORPHAN = "user_closure_orphan";
  await seedAccount(ORPHAN, { customer: "cus_closure_orphan", waitlist: true });
  const failing = recordingCanceller({ throws: true });
  const sweep = await sweepOrphanedAccounts({ now: new Date(), lookup: async () => new Set(), maxCandidates: 50 });
  check("the sweep purged the orphan", sweep.purged >= 1, JSON.stringify(sweep));
  check("the cancel was attempted", failing.some((c) => c.customerId === "cus_closure_orphan"));
  check("the erasure still completed", (await count("user_settings", sql`user_id = ${ORPHAN}`)) === 0);
  check("...including the waitlist row", (await count("interest_list_signups", sql`lower(email) = ${`${ORPHAN}@example.test`}`)) === 0);
  const queued = await db.select().from(billingCancellationQueue);
  check("the customer id is queued, and nothing else about the person", queued.length === 1 && queued[0].stripeCustomerId === "cus_closure_orphan" && !JSON.stringify(queued).includes(ORPHAN));

  const stillDown = await retryQueuedCancellations({ now: new Date() });
  const [afterFail] = await db.select().from(billingCancellationQueue);
  check("a failed retry keeps the row and counts the attempt", stillDown.stillFailing === 1 && afterFail?.attempts === 2);

  const recovered = recordingCanceller();
  const drained = await retryQueuedCancellations({ now: new Date() });
  check("once Stripe answers, the retry cancels it", drained.cancelled === 1 && recovered[0]?.customerId === "cus_closure_orphan");
  check("...and the queue is empty", (await count("billing_cancellation_queue", sql`true`)) === 0);

  // ------------------------------------------------------------ keep the account: no cancel
  console.log("\nDelete all data but keep the account");
  const KEEPER = "user_closure_keeper";
  await seedAccount(KEEPER, { customer: "cus_closure_keeper", waitlist: true });
  const none = recordingCanceller();
  await purgeUserData(KEEPER); // every category, keepSettings defaults to true
  check("no subscription is cancelled", none.length === 0, JSON.stringify(none));
  check("the settings row (and its Stripe link) is kept", (await count("user_settings", sql`user_id = ${KEEPER} AND stripe_customer_id = 'cus_closure_keeper'`)) === 1);
  check("the waitlist row is kept (the account still exists)", (await count("interest_list_signups", sql`lower(email) = ${`${KEEPER}@example.test`}`)) === 1);

  setSubscriptionCancellerForTests(null);
  if (failures > 0) throw new Error(`${failures} account-closure check(s) failed`);
  console.log("\nAll account-closure checks passed.");
}

run(main);
