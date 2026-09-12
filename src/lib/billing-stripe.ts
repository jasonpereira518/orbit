import type Stripe from "stripe";
import type { BillingEventKind } from "@/db/schema";
import {
  ANNUAL_MONTHLY_EQUIVALENT_CENTS,
  MONTHLY_CENTS,
  classifyMovement,
} from "@/lib/billing-events";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_BILLING_PERIOD_METADATA_KEY,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "@/lib/stripe";

/**
 * What a Stripe event means, decided without touching anything.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. The webhook route used to read the mirror, write
 * it, then read it back to work out what had just happened. That is untestable without a
 * database and — more importantly — unreplayable: a backfill cannot re-derive history
 * through a function that insists on consulting the present. Pulling the decision out as a
 * pure function of (event, context) is what lets the live path and the backfill share one
 * implementation instead of two that drift.
 *
 * Imports Stripe for TYPES ONLY. No `getStripe()`, no `@/db`, no `next/server` — the last
 * of those would hang every tsx script that reaches this module.
 *
 * THE RULE THAT MAKES DOUBLE-COUNTING STRUCTURALLY IMPOSSIBLE:
 *
 *   Cash rows are keyed by the object that IS the dollar.
 *   MRR rows are keyed by the event.
 *   No event ever books both.
 *
 * An MRR movement really is an event — one subscription produces many of them and there is
 * no per-movement object to point at, so `event.id` is the honest key. A dollar really is
 * an object: an invoice, a refund, a session, each with a stable id that SEVERAL different
 * event types announce. Keying cash on the event id is precisely what would let two event
 * types book the same dollar twice — and it is not hypothetical, because
 * `checkout.session.completed` and `checkout.session.async_payment_succeeded` fire for the
 * same Lifetime session with different event ids. Both compute `cs:<session_id>` here, and
 * the unique index drops the second.
 *
 * Stripe event ids always begin `evt_`, so these namespaces cannot collide with each other
 * or with any row already written.
 */

/** How often a subscription bills. Display only; the money is carried by cents. */
export type BillingInterval = "month" | "year";

/**
 * One row to write into `billing_events`.
 *
 * `amountCents` and `mrrDeltaCents` are never both non-zero on the same booking. That is
 * the invariant every consumer relies on: summing either column across all rows cannot
 * double-count, no matter how many events Stripe fires for one dollar.
 */
export type Booking = {
  eventId: string;
  kind: BillingEventKind;
  userId: string | null;
  amountCents?: number;
  mrrDeltaCents?: number;
  effectiveAt: Date;
  detail: Record<string, unknown>;
};

export type MirrorInstruction =
  | {
      type: "subscription";
      userId: string;
      plan: "orbit" | null;
      status: "active" | "past_due" | "canceled" | null;
      periodEnd: number | null;
      monthlyCents: number | null;
      interval: BillingInterval | null;
      stripeCustomerId: string | null;
    }
  | { type: "lifetime"; userId: string; stripeCustomerId: string | null }
  | null;

export type StripeDecision = {
  mirror: MirrorInstruction;
  bookings: Booking[];
  outcome: "handled" | "ignored";
  reason?: string;
  targetUserId: string | null;
  resourceId: string | null;
};

export type DecideContext = {
  /** Resolved by the caller, which is the only part of this that needs a database. */
  userId: string | null;
  /** Recurring value immediately before this event, in cents per month. */
  beforeCents: number;
  /** Whether this account has ever produced revenue — the reactivation gate. */
  hadPriorRevenue: boolean;
  now: Date;
};

/** Reasons this module can give for ignoring an event, added to `WEBHOOK_REASONS`. */
export const STRIPE_IGNORE_REASONS = {
  unpaidSession: "unpaid_session",
  noSubscriptionOnInvoice: "no_subscription_on_invoice",
  zeroAmount: "zero_amount",
  currencyUnsupported: "currency_unsupported",
  disputeWon: "dispute_won",
  noMovement: "no_movement",
} as const;

/* --------------------------------------------------------------- shape readers ------ */

/** `customer` arrives as an id, an expanded object, or null depending on the object. */
export function customerIdOf(obj: {
  customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null;
}): string | null {
  const customer = obj.customer;
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * The monthly-equivalent value of a price, in cents.
 *
 * Reads the PRICE rather than comparing against `PRO_ANNUAL_PRICE_ID`, so a price change
 * in Stripe, a grandfathered price, or a second currency-scoped price all book correctly
 * with no code change here. Annual is divided rather than special-cased, which is also the
 * only way `interval_count: 3` (quarterly) ever works without another branch.
 *
 * Returns null when the price is not recurring or carries no amount — "unknown", which the
 * caller turns into the monthly default, rather than a confident zero.
 */
export function monthlyEquivalentCents(
  price:
    | {
        unit_amount?: number | null;
        recurring?: { interval?: string; interval_count?: number | null } | null;
      }
    | null
    | undefined,
  quantity = 1
): number | null {
  const unit = price?.unit_amount;
  if (typeof unit !== "number") return null;

  const recurring = price?.recurring;
  const count =
    typeof recurring?.interval_count === "number" && recurring.interval_count > 0
      ? recurring.interval_count
      : 1;
  const total = unit * (quantity > 0 ? quantity : 1);

  switch (recurring?.interval) {
    case "year":
      return Math.round(total / (12 * count));
    case "month":
      return Math.round(total / count);
    case "week":
      return Math.round((total * 52) / (12 * count));
    case "day":
      return Math.round((total * 365) / (12 * count));
    default:
      return null;
  }
}

/**
 * Where the paid-through timestamp lives moved across Stripe API versions: recent versions
 * carry `current_period_end` on the subscription item, older ones on the subscription root.
 * The SDK is unpinned, so read the item first and fall back.
 */
export function periodEndOf(subscription: Stripe.Subscription): number | null {
  const item = subscription.items?.data?.[0] as
    | { current_period_end?: number }
    | undefined;
  if (typeof item?.current_period_end === "number") {
    return item.current_period_end;
  }
  const root = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  if (typeof root === "number") return root;
  console.error(
    `Stripe subscription ${subscription.id} carries no current_period_end on item or root.`
  );
  return null;
}

/** Period end, monthly value and interval, read defensively in one pass. */
export function subscriptionShape(subscription: Stripe.Subscription): {
  periodEnd: number | null;
  monthlyCents: number | null;
  interval: BillingInterval | null;
  priceId: string | null;
} {
  const item = subscription.items?.data?.[0];
  const price = item?.price as
    | {
        id?: string;
        unit_amount?: number | null;
        recurring?: { interval?: string; interval_count?: number | null } | null;
      }
    | undefined;

  const monthlyCents = monthlyEquivalentCents(price, item?.quantity ?? 1);
  const rawInterval = price?.recurring?.interval;

  return {
    periodEnd: periodEndOf(subscription),
    monthlyCents,
    interval:
      rawInterval === "year" ? "year" : rawInterval === "month" ? "month" : null,
    priceId: price?.id ?? null,
  };
}

/**
 * Newer Stripe API versions moved the subscription reference off the invoice root and into
 * `parent.subscription_details.subscription`. Read both, for the same reason `periodEndOf`
 * does: the SDK version is not pinned here.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const root = (invoice as unknown as {
    subscription?: string | { id?: string } | null;
  }).subscription;
  if (typeof root === "string") return root;
  if (root && typeof root === "object" && typeof root.id === "string") return root.id;

  const nested = (invoice as unknown as {
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } };
  }).parent?.subscription_details?.subscription;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object" && typeof nested.id === "string") {
    return nested.id;
  }
  return null;
}

/**
 * Last-resort interval inference for a Checkout Session created before the billing-period
 * metadata existed. Costs no API call and is only ever consulted when the metadata is
 * absent, so the blast radius is the deploy window itself.
 */
export function intervalFromAmountTotal(
  amountTotal: number | null | undefined
): BillingInterval | null {
  if (amountTotal === ANNUAL_CENTS_TOTAL) return "year";
  if (amountTotal === MONTHLY_CENTS) return "month";
  return null;
}

const ANNUAL_CENTS_TOTAL = 5000;

function monthlyCentsForInterval(interval: BillingInterval | null): number {
  return interval === "year" ? ANNUAL_MONTHLY_EQUIVALENT_CENTS : MONTHLY_CENTS;
}

/* ------------------------------------------------------------- attribution hint ----- */

/**
 * Who and what an event is about, as far as the payload alone can say.
 *
 * Kept separate from `decideStripeEvent` because resolving a customer id to a user needs
 * the database, and this module must not touch it. The route resolves, then decides.
 */
export function stripeEventSubject(event: Stripe.Event): {
  userIdHint: string | null;
  customerId: string | null;
  resourceId: string | null;
} {
  const object = event.data.object as unknown as Record<string, unknown>;
  const resourceId = typeof object.id === "string" ? object.id : null;
  const metadata = (object.metadata ?? {}) as Record<string, string | undefined>;

  const userIdHint =
    (typeof object.client_reference_id === "string"
      ? object.client_reference_id
      : null) ||
    metadata[SUBSCRIPTION_USER_METADATA_KEY] ||
    null;

  return {
    userIdHint,
    customerId: customerIdOf(object as { customer?: string | null }),
    resourceId,
  };
}

/* ------------------------------------------------------------------- the decision --- */

function ignored(
  reason: string,
  targetUserId: string | null,
  resourceId: string | null
): StripeDecision {
  return { mirror: null, bookings: [], outcome: "ignored", reason, targetUserId, resourceId };
}

const secondsToDate = (seconds: number | null | undefined, fallback: Date): Date =>
  typeof seconds === "number" ? new Date(seconds * 1000) : fallback;

export function decideStripeEvent(
  event: Pick<Stripe.Event, "id" | "type" | "created" | "data">,
  ctx: DecideContext
): StripeDecision {
  const { userId, beforeCents, hadPriorRevenue } = ctx;
  const eventAt = secondsToDate(event.created, ctx.now);
  const { resourceId } = stripeEventSubject(event as Stripe.Event);

  switch (event.type) {
    /* ------------------------------------------------------------ checkout ---------- */
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const planMeta = session.metadata?.[LIFETIME_METADATA_KEY];
      const customerId = customerIdOf(session);

      if (!userId) return ignored("missing_user_id", null, resourceId);
      // `unpaid` covers sessions that completed without funds actually settling.
      if (session.payment_status === "unpaid") {
        return ignored(STRIPE_IGNORE_REASONS.unpaidSession, userId, resourceId);
      }

      if (planMeta === LIFETIME_METADATA_VALUE) {
        const amountCents = session.amount_total ?? 0;
        return {
          mirror: { type: "lifetime", userId, stripeCustomerId: customerId },
          // Keyed on the SESSION, not the event: the two fulfil events carry different
          // event ids for the same purchase and would otherwise both book the money.
          bookings: [
            {
              eventId: `cs:${session.id}`,
              kind: "lifetime",
              userId,
              // Taken from the session, never from LIFETIME_INTRO_PRICE: the offer moves
              // to the standard price at 100 sales, and what someone actually paid is the
              // fact worth keeping.
              amountCents,
              mrrDeltaCents: 0,
              effectiveAt: eventAt,
              detail: {
                checkoutSessionId: session.id,
                customerId,
                currency: session.currency ?? null,
              },
            },
          ],
          outcome: "handled",
          targetUserId: userId,
          resourceId,
        };
      }

      if (planMeta === PRO_METADATA_VALUE) {
        // The interval has to be known HERE. The optimistic grant establishes the "after"
        // value, and if it books $5 while the subscription is really annual, the next
        // `customer.subscription.updated` computes 417 against 500 and books a spurious
        // -83 contraction on every single annual signup.
        const interval =
          (session.metadata?.[PRO_BILLING_PERIOD_METADATA_KEY] === "annual"
            ? "year"
            : session.metadata?.[PRO_BILLING_PERIOD_METADATA_KEY] === "monthly"
              ? "month"
              : null) ?? intervalFromAmountTotal(session.amount_total);
        const monthlyCents = monthlyCentsForInterval(interval);
        const movement = classifyMovement(beforeCents, monthlyCents, {
          hadPriorRevenue,
        });

        return {
          mirror: {
            type: "subscription",
            userId,
            plan: "orbit",
            status: "active",
            // The first `customer.subscription.updated` fills in the real period end.
            periodEnd: null,
            monthlyCents,
            interval,
            stripeCustomerId: customerId,
          },
          bookings: movement
            ? [
                {
                  eventId: event.id,
                  kind: movement.kind,
                  userId,
                  amountCents: 0,
                  mrrDeltaCents: movement.deltaCents,
                  effectiveAt: eventAt,
                  detail: {
                    checkoutSessionId: session.id,
                    beforeCents,
                    afterCents: monthlyCents,
                    interval,
                  },
                },
              ]
            : [],
          outcome: "handled",
          targetUserId: userId,
          resourceId,
        };
      }

      return ignored("other_plan_slug", userId, resourceId);
    }

    /* -------------------------------------------------- subscription lifecycle ------ */
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const planMeta = subscription.metadata?.[LIFETIME_METADATA_KEY];
      if (planMeta && planMeta !== PRO_METADATA_VALUE) {
        return ignored("other_plan_slug", userId, resourceId);
      }
      if (!userId) return ignored("missing_user_id", null, resourceId);

      const shape = subscriptionShape(subscription);
      const terminal = event.type === "customer.subscription.deleted";
      const status = terminal ? "canceled" : subscription.status;

      let plan: "orbit" | null;
      let mirrorStatus: "active" | "past_due" | "canceled" | null;
      switch (status) {
        case "active":
        case "trialing":
          plan = "orbit";
          mirrorStatus = "active";
          break;
        case "past_due":
          plan = "orbit";
          mirrorStatus = "past_due";
          break;
        case "canceled":
          plan = "orbit";
          mirrorStatus = "canceled";
          break;
        default:
          // incomplete, incomplete_expired, unpaid, paused — never live entitlement.
          plan = null;
          mirrorStatus = null;
      }

      const monthlyCents = shape.monthlyCents ?? MONTHLY_CENTS;

      /*
       * A terminal event forces the recurring value to zero rather than re-deriving it.
       *
       * `customer.subscription.deleted` fires AT the period end, so `periodEnd > now` is a
       * coin flip decided by clock skew and Stripe's own rounding. Re-deriving it returns
       * the full value about half the time, `classifyMovement` sees no change, and the
       * churn is never recorded — with no later event to correct it. The existing smoke
       * test hides this by using a period end a day in the past.
       */
      const afterCents = terminal
        ? 0
        : mirrorStatus === null
          ? 0
          : mirrorStatus === "canceled"
            ? shape.periodEnd && shape.periodEnd * 1000 > eventAt.getTime()
              ? monthlyCents
              : 0
            : monthlyCents;

      const movement = classifyMovement(beforeCents, afterCents, { hadPriorRevenue });

      return {
        mirror: {
          type: "subscription",
          userId,
          plan,
          status: mirrorStatus,
          periodEnd: terminal ? shape.periodEnd : shape.periodEnd,
          monthlyCents: plan ? monthlyCents : null,
          interval: plan ? shape.interval : null,
          stripeCustomerId: customerIdOf(subscription),
        },
        bookings: movement
          ? [
              {
                eventId: event.id,
                kind: terminal ? "churn" : movement.kind,
                userId,
                amountCents: 0,
                mrrDeltaCents: movement.deltaCents,
                effectiveAt: eventAt,
                detail: {
                  subscriptionId: subscription.id,
                  stripeStatus: status,
                  beforeCents,
                  afterCents,
                  interval: shape.interval,
                  priceId: shape.priceId,
                  ...(terminal ? { terminal: true } : {}),
                },
              },
            ]
          : [],
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }

    /* -------------------------------------------------------------- invoices -------- */
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = invoiceSubscriptionId(invoice);

      // Subscription invoices only. A Lifetime purchase with `invoice_creation` enabled
      // would otherwise book its money twice — once as `cs:` and once as `in:`.
      if (!subscriptionId) {
        return ignored(
          STRIPE_IGNORE_REASONS.noSubscriptionOnInvoice,
          userId,
          resourceId
        );
      }
      const amountPaid = invoice.amount_paid ?? 0;
      // $0 invoices: a 100% coupon, or the invoice Stripe raises at trial end.
      if (amountPaid <= 0) {
        return ignored(STRIPE_IGNORE_REASONS.zeroAmount, userId, resourceId);
      }
      if (!userId) return ignored("missing_user_id", null, resourceId);

      const currency = (invoice.currency ?? "usd").toLowerCase();
      // Orbit sells in USD. Booking a foreign amount into a USD total is arithmetic on
      // incompatible units; skipping it silently loses money invisibly. Record the row at
      // zero with the real figures in `detail` — visible, and structurally unable to
      // inflate the total.
      const unconverted = currency !== "usd";

      return {
        mirror: null,
        bookings: [
          {
            // Keyed on the INVOICE. `invoice.paid` and `invoice.payment_succeeded` both
            // fire for it, so subscribing to both by accident stays harmless.
            eventId: `in:${invoice.id}`,
            kind: "payment",
            userId,
            amountCents: unconverted ? 0 : amountPaid,
            mrrDeltaCents: 0,
            effectiveAt: secondsToDate(
              invoice.status_transitions?.paid_at,
              eventAt
            ),
            detail: {
              invoiceId: invoice.id,
              subscriptionId,
              billingReason: invoice.billing_reason ?? null,
              currency,
              ...(unconverted ? { amountPaid, unconverted: true } : {}),
            },
          },
        ],
        outcome: "handled",
        ...(unconverted ? { reason: STRIPE_IGNORE_REASONS.currencyUnsupported } : {}),
        targetUserId: userId,
        resourceId,
      };
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (!userId) return ignored("missing_user_id", null, resourceId);
      return {
        mirror: null,
        bookings: [
          {
            eventId: event.id,
            kind: "payment_failed",
            userId,
            amountCents: 0,
            mrrDeltaCents: 0,
            effectiveAt: eventAt,
            detail: {
              invoiceId: invoice.id,
              subscriptionId: invoiceSubscriptionId(invoice),
              attemptCount: invoice.attempt_count ?? null,
              amountDue: invoice.amount_due ?? null,
            },
          },
        ],
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }

    /* --------------------------------------------------------------- charges -------- */
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      if (!userId) return ignored("missing_user_id", null, resourceId);

      /*
       * ONE ROW PER REFUND, keyed by the refund's own id.
       *
       * `charge.refunded` fires once per refund and carries a CUMULATIVE
       * `amount_refunded`. Booking that field turns two partial refunds of 500 into
       * 500 + 1000 = 1500. Iterating the refunds and keying each individually removes the
       * arithmetic entirely: the second event re-books refund #1, which the unique index
       * drops, and books #2, which is new. No ordering assumption, no read-modify-write.
       */
      const refunds = charge.refunds?.data ?? [];
      const bookings: Booking[] = refunds
        .filter((refund) => (refund.amount ?? 0) > 0)
        .map((refund) => ({
          eventId: `re:${refund.id}`,
          kind: "refund" as const,
          userId,
          amountCents: refund.amount ?? 0,
          mrrDeltaCents: 0,
          effectiveAt: secondsToDate(refund.created, eventAt),
          detail: {
            chargeId: charge.id,
            refundId: refund.id,
            reason: refund.reason ?? null,
            currency: charge.currency ?? null,
          },
        }));

      if (bookings.length === 0) {
        // A charge whose refunds were not expanded. Falling back to `amount_refunded`
        // keyed on the charge would double-count the moment a second partial arrives, so
        // record nothing and say why rather than book a number that can grow wrong.
        return ignored(STRIPE_IGNORE_REASONS.zeroAmount, userId, resourceId);
      }

      return {
        mirror: null,
        bookings,
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }

    /* -------------------------------------------------------------- disputes -------- */
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!userId) return ignored("missing_user_id", null, resourceId);
      // An incident, not yet a loss. Booking the cash out here and again on a lost close
      // would double it; booking it here and never reversing a WON dispute would remove
      // money that was never lost.
      return {
        mirror: null,
        bookings: [
          {
            eventId: event.id,
            kind: "payment_failed",
            userId,
            amountCents: 0,
            mrrDeltaCents: 0,
            effectiveAt: eventAt,
            detail: {
              disputeId: dispute.id,
              chargeId:
                typeof dispute.charge === "string"
                  ? dispute.charge
                  : (dispute.charge?.id ?? null),
              disputedCents: dispute.amount ?? 0,
              reason: dispute.reason ?? null,
            },
          },
        ],
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }

    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!userId) return ignored("missing_user_id", null, resourceId);
      if (dispute.status !== "lost") {
        return ignored(STRIPE_IGNORE_REASONS.disputeWon, userId, resourceId);
      }
      return {
        mirror: null,
        bookings: [
          {
            eventId: `dp:${dispute.id}`,
            kind: "refund",
            userId,
            amountCents: dispute.amount ?? 0,
            mrrDeltaCents: 0,
            effectiveAt: eventAt,
            detail: {
              disputeId: dispute.id,
              chargeId:
                typeof dispute.charge === "string"
                  ? dispute.charge
                  : (dispute.charge?.id ?? null),
              outcome: "lost",
            },
          },
        ],
        outcome: "handled",
        targetUserId: userId,
        resourceId,
      };
    }

    default:
      return ignored("unhandled_type", userId, resourceId);
  }
}
