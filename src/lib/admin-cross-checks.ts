import { getDb, rowsOf, SCHEMA_VERSION } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Checks where two systems that should agree are compared, rather than one system probed.
 *
 * A provider row says "Stripe is up". It cannot say "Stripe took the money and Orbit never
 * credited it", which is the failure that actually costs something, because each side looks
 * healthy on its own. Every check here is a single read against Orbit's own database — no
 * extra calls to a third party, so this adds nothing to the page's provider budget — and
 * names the two things it is holding up against each other.
 *
 * A check that cannot run reports `unknown`, never `ok`: "I could not look" must not read
 * as "nothing is wrong".
 */

export type CrossCheckTone = "ok" | "warn" | "danger" | "unknown";

export type CrossCheck = {
  id: string;
  label: string;
  /** The two systems being compared, in the order the sentence reads. */
  between: [string, string];
  tone: CrossCheckTone;
  summary: string;
  /** How many records disagree, when the check counts them. */
  count: number | null;
};

/** A Lifetime checkout this old that never resolved is not just a slow browser tab. */
const CHECKOUT_UNRESOLVED_MS = 2 * 60 * 60 * 1000;
/** A renewal webhook this late is not clock skew. */
const PERIOD_LAPSED_MS = 3 * 24 * 60 * 60 * 1000;
/** The sweep runs every ten minutes; an alert still unannounced after three runs was missed. */
const ALERT_UNANNOUNCED_MS = 30 * 60 * 1000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Pure: how the recorded schema version compares with the version this build expects. */
export function schemaVersionCheck(recorded: number | null, expected: number): CrossCheck {
  const base = {
    id: "schema-version",
    label: "Schema version",
    between: ["the deployed build", "the database"] as [string, string],
    count: null,
  };
  if (recorded === null) {
    return { ...base, tone: "unknown", summary: "The database has no recorded schema version to compare." };
  }
  if (recorded < expected) {
    return {
      ...base,
      tone: "danger",
      summary: `The build expects schema ${expected} but the database is at ${recorded}: the last migration did not complete.`,
    };
  }
  if (recorded > expected) {
    return {
      ...base,
      tone: "warn",
      summary: `The database is at ${recorded}, ahead of this build's ${expected}: an older build is serving after a rollback.`,
    };
  }
  return { ...base, tone: "ok", summary: `Both at schema ${expected}.` };
}

/** Pure: whether Blob being set up agrees with where avatars actually live. */
export function blobAvatarCheck(blobConfigured: boolean, inlinedAvatars: number | null): CrossCheck {
  const base = {
    id: "blob-avatars",
    label: "Avatar storage",
    between: ["Vercel Blob", "contact photos"] as [string, string],
  };
  if (inlinedAvatars === null) {
    return { ...base, tone: "unknown", count: null, summary: "Could not count inlined avatars." };
  }
  if (inlinedAvatars === 0) {
    return {
      ...base,
      tone: "ok",
      count: 0,
      summary: blobConfigured
        ? "Every photo is in Blob."
        : "No photos are inlined, though Blob is not configured.",
    };
  }
  return {
    ...base,
    tone: "warn",
    count: inlinedAvatars,
    summary: blobConfigured
      ? `${plural(inlinedAvatars, "photo")} still stored as base64 in Postgres although Blob is set up.`
      : `${plural(inlinedAvatars, "photo")} stored as base64 in Postgres because Blob is not configured.`,
  };
}

/** Pure: whether open alerts have actually been announced anywhere. */
export function alertDeliveryCheck(args: {
  slackConfigured: boolean;
  openAlerts: number;
  unannounced: number;
  unannouncedCritical: number;
}): CrossCheck {
  const base = {
    id: "alert-delivery",
    label: "Alert delivery",
    between: ["open alerts", "Slack"] as [string, string],
  };
  if (!args.slackConfigured) {
    return {
      ...base,
      tone: args.openAlerts > 0 ? "danger" : "warn",
      count: args.openAlerts,
      summary:
        args.openAlerts > 0
          ? `Slack is not configured, so ${plural(args.openAlerts, "open alert")} reached nobody.`
          : "Slack is not configured, so no alert can reach anyone.",
    };
  }
  if (args.unannounced > 0) {
    return {
      ...base,
      tone: args.unannouncedCritical > 0 ? "danger" : "warn",
      count: args.unannounced,
      summary: `${plural(args.unannounced, "open alert")} never announced after half an hour — the alert bot may be failing.`,
    };
  }
  return { ...base, tone: "ok", count: 0, summary: "Every open alert has been announced." };
}

/** Pure: the three Stripe-vs-account comparisons, from their counts. */
export function stripeChecks(c: { checkouts: number; noCustomer: number; lapsed: number }): CrossCheck[] {
  return [
    {
      id: "stripe-checkouts",
      label: "Lifetime checkouts",
      between: ["Stripe Checkout", "accounts"],
      tone: c.checkouts > 0 ? "warn" : "ok",
      count: c.checkouts,
      summary:
        c.checkouts > 0
          ? `${plural(c.checkouts, "checkout")} opened over two hours ago and never resolved: abandoned, or paid and never credited.`
          : "No checkout is stuck open.",
    },
    {
      id: "stripe-customer",
      label: "Subscription mirror",
      between: ["Stripe customers", "account plans"],
      tone: c.noCustomer > 0 ? "danger" : "ok",
      count: c.noCustomer,
      summary:
        c.noCustomer > 0
          ? `${plural(c.noCustomer, "account")} marked subscribed with no Stripe customer attached.`
          : "Every subscribed account has a Stripe customer.",
    },
    {
      id: "stripe-renewals",
      label: "Subscription renewals",
      between: ["Stripe renewals", "account plans"],
      tone: c.lapsed > 0 ? "warn" : "ok",
      count: c.lapsed,
      summary:
        c.lapsed > 0
          ? `${plural(c.lapsed, "account")} still active more than three days past their period end: a renewal or cancel webhook was missed.`
          : "No active subscription is past its period end.",
    },
  ];
}

export async function getCrossServiceChecks(
  opts: { inlinedAvatars: number | null; now?: Date } = { inlinedAvatars: null }
): Promise<CrossCheck[]> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const checkoutCutoff = new Date(now.getTime() - CHECKOUT_UNRESOLVED_MS).toISOString();
  const lapsedCutoff = new Date(now.getTime() - PERIOD_LAPSED_MS).toISOString();
  const alertCutoff = new Date(now.getTime() - ALERT_UNANNOUNCED_MS).toISOString();

  // Independent reads, each allowed to fail alone: one missing table must not blank the rest.
  const [stripeRes, versionRes, alertRes] = await Promise.allSettled([
    db.execute(sql`
      SELECT
        count(*) FILTER (WHERE lifetime_checkout_session_id IS NOT NULL
          AND lifetime_purchased_at IS NULL
          AND lifetime_checkout_started_at < ${checkoutCutoff}::timestamptz)::int AS checkouts,
        count(*) FILTER (WHERE subscription_status IN ('active', 'past_due')
          AND stripe_customer_id IS NULL)::int AS no_customer,
        count(*) FILTER (WHERE subscription_status = 'active'
          AND subscription_period_end < ${lapsedCutoff}::timestamptz)::int AS lapsed
      FROM user_settings`),
    db.execute(sql`SELECT version FROM schema_migrations WHERE id = 1`),
    db.execute(sql`
      SELECT
        count(*)::int AS open,
        count(*) FILTER (WHERE notify_count = 0
          AND opened_at < ${alertCutoff}::timestamptz)::int AS unannounced,
        count(*) FILTER (WHERE notify_count = 0 AND severity = 'critical'
          AND opened_at < ${alertCutoff}::timestamptz)::int AS unannounced_critical
      FROM ops_alert_state WHERE active`),
  ]);

  const out: CrossCheck[] = [];

  if (stripeRes.status === "fulfilled") {
    const r = rowsOf<{ checkouts: number; no_customer: number; lapsed: number }>(stripeRes.value)[0];
    out.push(
      ...stripeChecks({
        checkouts: r?.checkouts ?? 0,
        noCustomer: r?.no_customer ?? 0,
        lapsed: r?.lapsed ?? 0,
      })
    );
  } else {
    out.push({
      id: "stripe-accounts",
      label: "Stripe vs account plans",
      between: ["Stripe", "account plans"],
      tone: "unknown",
      count: null,
      summary: "Could not read subscription state.",
    });
  }

  if (alertRes.status === "fulfilled") {
    const r = rowsOf<{ open: number; unannounced: number; unannounced_critical: number }>(alertRes.value)[0];
    out.push(
      alertDeliveryCheck({
        slackConfigured: Boolean(
          process.env.SLACK_OPS_WEBHOOK_URL?.trim() || process.env.SLACK_BOT_TOKEN?.trim()
        ),
        openAlerts: r?.open ?? 0,
        unannounced: r?.unannounced ?? 0,
        unannouncedCritical: r?.unannounced_critical ?? 0,
      })
    );
  } else {
    out.push({
      id: "alert-delivery",
      label: "Alert delivery",
      between: ["open alerts", "Slack"],
      tone: "unknown",
      count: null,
      summary: "Could not read alert state.",
    });
  }

  out.push(blobAvatarCheck(Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()), opts.inlinedAvatars));

  const recorded =
    versionRes.status === "fulfilled"
      ? (rowsOf<{ version: number }>(versionRes.value)[0]?.version ?? null)
      : null;
  out.push(schemaVersionCheck(recorded === null ? null : Number(recorded), SCHEMA_VERSION));

  return out;
}

/** How many checks disagree: what the Health banner and the tab badge count. */
export function crossCheckIssues(checks: CrossCheck[] | null): number {
  return checks?.filter((c) => c.tone === "warn" || c.tone === "danger").length ?? 0;
}
