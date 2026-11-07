import { NextResponse } from "next/server";
import { isNotNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import {
  LIVE_STRIPE_STATUSES,
  compareStripeToDb,
  viewStripeSubscription,
  type StripeSubView,
} from "@/lib/billing-reconcile";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Daily: Stripe's live subscriptions against `user_settings`.
 *
 * The ledger's drift panel compares two things Orbit itself wrote, so a dropped webhook makes
 * both wrong together and the panel reads zero. This asks Stripe. It is READ-ONLY on both
 * sides (`subscriptions.list`, a SELECT) and records only counts: the run row carries
 * `{checked, mismatches, <kind>…}`, which `billing.stripe_drift` (src/lib/product-alerts.ts)
 * turns into a critical alert. The response to the caller does include account ids so the
 * operator running it by hand can see who to look at.
 *
 * Same shared-secret gate and scheduler as `/api/ops/speech-usage`. Without a Stripe key the
 * job records itself as `partial` with `skipped: true` rather than failing: an environment with
 * no Stripe has nothing to reconcile.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) return new NextResponse(null, { status: 401 });

  const run = await startCronRun("billing.reconcile");
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      await finishCronRun(run, { status: "partial", stats: { skipped: true, checked: 0, mismatches: 0 } });
      return NextResponse.json({ skipped: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const stripe = getStripe();
    const views: StripeSubView[] = [];
    for (const status of LIVE_STRIPE_STATUSES) {
      for await (const sub of stripe.subscriptions.list({ status, limit: 100, expand: ["data.items.data.price"] })) {
        views.push(viewStripeSubscription(sub));
      }
    }

    const db = await getDb();
    const rows = await db
      .select({
        userId: userSettings.userId,
        stripeCustomerId: userSettings.stripeCustomerId,
        subscriptionPlan: userSettings.subscriptionPlan,
        subscriptionStatus: userSettings.subscriptionStatus,
        subscriptionMonthlyCents: userSettings.subscriptionMonthlyCents,
      })
      .from(userSettings)
      .where(or(isNotNull(userSettings.subscriptionPlan), isNotNull(userSettings.stripeCustomerId)));

    const result = compareStripeToDb(views, rows);
    await finishCronRun(run, {
      status: "ok",
      stats: { checked: result.checked, mismatches: result.mismatches.length, ...result.byKind },
    });
    return NextResponse.json(
      { checked: result.checked, mismatches: result.mismatches, byKind: result.byKind },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const ref = reportError(err, { where: "job.billing-reconcile" });
    await finishCronRun(run, { status: "failed", error: err });
    return NextResponse.json({ error: "reconcile failed", ref }, { status: 503 });
  }
}
