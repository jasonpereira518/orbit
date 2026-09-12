/**
 * Rebuilds `billing_events` from Stripe's own object history.
 *
 * The ledger only began recording money when the webhook learned how, so every sale
 * before that is missing and the Money screen's charts start at a cliff. This replays what
 * Stripe still knows.
 *
 * READS OBJECTS, NOT EVENTS. Stripe retains events for 30 days; subscriptions, invoices,
 * refunds and disputes have no retention window. That is the only way to reach real
 * history, and it is why the cash rows here are keyed exactly as the webhook keys them
 * (`in:` / `cs:` / `re:` / `dp:`) — a backfilled invoice and a live-webhook invoice are
 * literally the same row, so the two can overlap freely without double-counting.
 *
 * Only MRR rows can collide, since they are keyed `bf:<subscription>:<slot>` rather than
 * by an event id that does not exist. Those are bounded by a cutover timestamp, checked
 * against an overlap detector, and permanently reversible:
 *
 *     DELETE FROM billing_events WHERE source = 'stripe' AND event_id LIKE 'bf:%';
 *
 * Run:
 *   npx tsx scripts/backfill-billing-events.ts                          # dry run
 *   npx tsx scripts/backfill-billing-events.ts --confirm <host> --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import Stripe from "stripe";
import { and, asc, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { billingEvents } from "../src/db/schema";
import { recordBillingEventStrict } from "../src/lib/billing-events";
import {
  BACKFILL_PREFIX,
  looksAlreadyBooked,
  replayMovements,
  type PlannedBooking,
  type SubscriptionMovement,
} from "../src/lib/billing-backfill";
import {
  monthlyEquivalentCents,
  invoiceSubscriptionId,
} from "../src/lib/billing-stripe";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe";
import { findUserIdByStripeCustomerId } from "../src/lib/user-settings";

/* ------------------------------------------------------------------ arguments ------- */

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const APPLY = has("--apply");
const CONFIRM = valueOf("--confirm");
const ALLOW_TEST_INTO_REMOTE = has("--allow-test-into-remote");
const UNTIL_OVERRIDE = valueOf("--until");

/* ---------------------------------------------------------------------- guard ------- */

/**
 * The wrong-database guard, INVERTED from the seed scripts.
 *
 * A seed script's danger is writing to production, so those delete `DATABASE_URL` and
 * force PGlite. A backfill's legitimate target usually IS production — the whole point is
 * to repair the real ledger — so it cannot simply refuse remote databases. Instead it
 * makes the operator type the host they are about to write to. A generic `--yes` becomes
 * muscle memory; a host does not.
 */
function resolveTarget(): { label: string; host: string | null } {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return { label: "local PGlite (.data/pglite)", host: null };
  try {
    const host = new URL(url).host;
    return { label: host, host };
  } catch {
    return { label: "malformed DATABASE_URL", host: null };
  }
}

function guard(target: { label: string; host: string | null }, live: boolean) {
  if (live && !target.host) {
    fail(
      "Refusing: live Stripe keys against a local database.\n" +
        "Real money into a throwaway PGlite instance is always a mistake."
    );
  }
  if (!live && target.host && !ALLOW_TEST_INTO_REMOTE) {
    fail(
      `Refusing: test-mode Stripe data into remote database ${target.host}.\n` +
        "Test rows in a production ledger are as wrong as the reverse.\n" +
        "Pass --allow-test-into-remote if that is genuinely what you want."
    );
  }
  if (APPLY && target.host && CONFIRM !== target.host) {
    fail(
      `Refusing: this would write to ${target.host}.\n` +
        `Re-run with --confirm ${target.host} to confirm the target.`
    );
  }
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ pagination ------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Manual `starting_after` paging rather than `autoPagingEach`, which hides both the
 * throttle and the ordering. Retries on rate limits and transient 5xx — at this volume the
 * whole run is dozens of requests, so this is for the pathological case, not the normal one.
 */
async function* pageAll<T extends { id: string }>(
  fetchPage: (startingAfter?: string) => Promise<Stripe.ApiList<T>>
): AsyncGenerator<T> {
  let cursor: string | undefined;
  for (;;) {
    let page: Stripe.ApiList<T> | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        page = await fetchPage(cursor);
        break;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 0;
        if (status !== 429 && status < 500) throw err;
        await sleep(Math.min(2 ** attempt * 250, 8000) + Math.random() * 250);
      }
    }
    if (!page) throw new Error("Stripe paging failed after 6 attempts.");

    for (const item of page.data) yield item;
    if (!page.has_more || page.data.length === 0) return;
    cursor = page.data[page.data.length - 1]!.id;
    await sleep(100);
  }
}

/* ---------------------------------------------------------------- attribution ------- */

const userCache = new Map<string, string | null>();

async function userFor(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
  metadata?: Stripe.Metadata | null,
  clientReferenceId?: string | null
): Promise<string | null> {
  const fromMeta =
    clientReferenceId || metadata?.[SUBSCRIPTION_USER_METADATA_KEY] || null;
  if (fromMeta) return fromMeta;

  const id = !customer ? null : typeof customer === "string" ? customer : customer.id;
  if (!id) return null;
  if (userCache.has(id)) return userCache.get(id)!;

  const resolved = await findUserIdByStripeCustomerId(id);
  userCache.set(id, resolved);
  return resolved;
}

/* --------------------------------------------------------------------- main --------- */

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) fail("STRIPE_SECRET_KEY is not set; nothing to read from.");

  const live = key.startsWith("sk_live_");
  const target = resolveTarget();
  guard(target, live);

  const stripe = new Stripe(key);
  const db = await getDb();

  /*
   * The cutover, derived rather than guessed: the earliest genuine webhook row. Everything
   * strictly before it is the backfill's to write; everything from it onward already has,
   * or will have, a real row.
   */
  let until: Date | null = UNTIL_OVERRIDE ? new Date(UNTIL_OVERRIDE) : null;
  if (!until) {
    const earliest = await db
      .select({ at: billingEvents.effectiveAt })
      .from(billingEvents)
      .where(
        and(
          sql`${billingEvents.source} = 'stripe'`,
          sql`${billingEvents.eventId} NOT LIKE ${`${BACKFILL_PREFIX}%`}`
        )
      )
      .orderBy(asc(billingEvents.effectiveAt))
      .limit(1);
    until = earliest[0]?.at ?? null;
  }

  console.log("Backfilling billing_events from Stripe object history\n");
  console.log(`  database   ${target.label}`);
  console.log(`  stripe     ${live ? "LIVE" : "test"} mode`);
  console.log(
    `  MRR cutoff ${until ? until.toISOString() : "none (ledger has no webhook rows yet)"}`
  );
  console.log(`  mode       ${APPLY ? "APPLY — will write" : "dry run — writes nothing"}\n`);

  const cash: PlannedBooking[] = [];
  const movements: SubscriptionMovement[] = [];
  let priceDrift = 0;

  /* --- subscriptions: the MRR timeline ------------------------------------------- */
  for await (const sub of pageAll<Stripe.Subscription>((startingAfter) =>
    stripe.subscriptions.list({
      status: "all",
      limit: 100,
      starting_after: startingAfter,
      expand: ["data.items.data.price"],
    })
  )) {
    const userId = await userFor(sub.customer, sub.metadata);
    if (!userId) continue;

    const item = sub.items?.data?.[0];
    const monthlyCents = monthlyEquivalentCents(item?.price, item?.quantity ?? 1);
    if (monthlyCents == null) continue;

    movements.push({
      userId,
      at: new Date(sub.start_date * 1000),
      afterCents: monthlyCents,
      subscriptionId: sub.id,
      slot: "new",
      detail: { priceId: item?.price?.id ?? null },
    });

    if (sub.ended_at) {
      movements.push({
        userId,
        at: new Date(sub.ended_at * 1000),
        afterCents: 0,
        subscriptionId: sub.id,
        slot: "churn",
      });
    }
    // A subscription object carries only its CURRENT price, so a mid-history plan change
    // is invisible and the whole timeline books at today's rate. Orbit has one price and
    // no switches yet, but the operator should hear about it rather than trust a number
    // that quietly went stale.
    if (sub.items?.data?.length && sub.items.data.length > 1) priceDrift++;
  }

  /* --- invoices: recurring cash --------------------------------------------------- */
  for await (const invoice of pageAll<Stripe.Invoice>((startingAfter) =>
    stripe.invoices.list({ status: "paid", limit: 100, starting_after: startingAfter })
  )) {
    const subscriptionId = invoiceSubscriptionId(invoice);
    const amount = invoice.amount_paid ?? 0;
    if (!subscriptionId || amount <= 0) continue;
    if ((invoice.currency ?? "usd").toLowerCase() !== "usd") continue;

    const userId = await userFor(invoice.customer);
    if (!userId) continue;

    cash.push({
      eventId: `in:${invoice.id}`,
      kind: "payment",
      userId,
      amountCents: amount,
      mrrDeltaCents: 0,
      effectiveAt: new Date(
        (invoice.status_transitions?.paid_at ?? invoice.created) * 1000
      ),
      detail: {
        invoiceId: invoice.id,
        subscriptionId,
        billingReason: invoice.billing_reason ?? null,
        backfilled: true,
      },
    });
  }

  /* --- checkout sessions: Lifetime cash ------------------------------------------- */
  for await (const session of pageAll<Stripe.Checkout.Session>((startingAfter) =>
    stripe.checkout.sessions.list({ limit: 100, starting_after: startingAfter })
  )) {
    if (session.metadata?.[LIFETIME_METADATA_KEY] !== LIFETIME_METADATA_VALUE) continue;
    if (session.payment_status === "unpaid") continue;

    const userId = await userFor(
      session.customer,
      session.metadata,
      session.client_reference_id
    );
    if (!userId) continue;

    cash.push({
      eventId: `cs:${session.id}`,
      kind: "lifetime",
      userId,
      amountCents: session.amount_total ?? 0,
      mrrDeltaCents: 0,
      effectiveAt: new Date(session.created * 1000),
      detail: { checkoutSessionId: session.id, backfilled: true },
    });
  }

  /* --- refunds and lost disputes: cash out ---------------------------------------- */
  for await (const refund of pageAll<Stripe.Refund>((startingAfter) =>
    stripe.refunds.list({ limit: 100, starting_after: startingAfter })
  )) {
    if ((refund.amount ?? 0) <= 0) continue;
    // A refund object carries no customer, and expanding every charge to find one would
    // multiply the request count for an attribution nothing on the Money screen reads at
    // the row level. Booked against a null user: the money left the account whether or not
    // we can say whose it was, and a dropped row would understate refunds instead.
    cash.push({
      eventId: `re:${refund.id}`,
      kind: "refund",
      userId: null,
      amountCents: refund.amount ?? 0,
      mrrDeltaCents: 0,
      effectiveAt: new Date(refund.created * 1000),
      detail: {
        refundId: refund.id,
        chargeId: typeof refund.charge === "string" ? refund.charge : null,
        backfilled: true,
      },
    });
  }

  for await (const dispute of pageAll<Stripe.Dispute>((startingAfter) =>
    stripe.disputes.list({ limit: 100, starting_after: startingAfter })
  )) {
    if (dispute.status !== "lost") continue;
    cash.push({
      eventId: `dp:${dispute.id}`,
      kind: "refund",
      userId: null,
      amountCents: dispute.amount ?? 0,
      mrrDeltaCents: 0,
      effectiveAt: new Date(dispute.created * 1000),
      detail: { disputeId: dispute.id, outcome: "lost", backfilled: true },
    });
  }

  /* --- replay MRR ----------------------------------------------------------------- */
  const plannedMrr = replayMovements(movements, until);

  const existing = await db
    .select({
      userId: billingEvents.userId,
      kind: billingEvents.kind,
      mrrDeltaCents: billingEvents.mrrDeltaCents,
      effectiveAt: billingEvents.effectiveAt,
    })
    .from(billingEvents)
    .where(sql`${billingEvents.eventId} NOT LIKE ${`${BACKFILL_PREFIX}%`}`);

  const overlapping = plannedMrr.filter((p) => looksAlreadyBooked(p, existing));
  const mrrToWrite = plannedMrr.filter((p) => !looksAlreadyBooked(p, existing));

  /* --- report and apply ------------------------------------------------------------ */
  const byKind = new Map<string, number>();
  for (const row of [...cash, ...mrrToWrite]) {
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  }

  console.log("Planned rows:");
  for (const [kind, n] of [...byKind].sort()) console.log(`  ${kind.padEnd(16)} ${n}`);
  if (overlapping.length > 0) {
    console.log(`\n  ${overlapping.length} MRR row(s) skipped — already booked by webhook.`);
  }
  if (priceDrift > 0) {
    console.log(
      `\n  WARNING: ${priceDrift} subscription(s) have multiple items. Only the first is\n` +
        "  priced, so their timeline may understate. Reconcile those by hand."
    );
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.\n");
    process.exit(0);
  }

  let inserted = 0;
  let already = 0;
  // Strict, not the swallowing variant: a backfill that silently drops rows produces a
  // confidently wrong Money screen, which is the failure this ledger exists to prevent.
  for (const row of [...cash, ...mrrToWrite]) {
    const wrote = await recordBillingEventStrict({ source: "stripe", ...row });
    if (wrote) inserted++;
    else already++;
  }

  console.log(`\nWrote ${inserted} row(s); ${already} were already present.\n`);
  process.exit(0);
}

// The import graph keeps the event loop alive, so every script here exits explicitly.
main().catch((err) => {
  console.error("\nBackfill failed:", err);
  process.exit(1);
});
