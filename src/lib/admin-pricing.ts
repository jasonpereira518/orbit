import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { num, toDate, type AdminUserRow } from "@/lib/admin-metrics";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

/**
 * Evidence for the two pricing questions: is the free cap set right, and is anything in
 * the wrong tier?
 *
 * WHAT MAKES THIS ANSWERABLE AT ALL is `gate_events`, which records every refusal. Before
 * it, the console could see what people *did* — `usage_events` is a log of things that
 * happened — and by construction nothing at all about what they tried and could not. That
 * is the entire demand signal for a gated feature, and it was invisible in both directions:
 * a wall people bounce off repeatedly looked identical to one nobody ever reaches.
 *
 * EVERYTHING HERE IS A LIST OF NAMED ACCOUNTS, not a rate. "38% of free users hit the cap"
 * over a dozen accounts is four people wearing a percentage; the four names are a to-do
 * list. Rates start being worth computing when the denominator is events, which is why the
 * per-feature hit counts below are counts and the per-account facts are rows.
 */

export type CapAccount = {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  contacts: number;
  /** When they FIRST hit the wall, from `gate_events`. Null if they have not. */
  firstBlockedAt: Date | null;
  /** How many times they have been refused since. */
  blockedCount: number;
};

export type ContactCapPicture = {
  limit: number;
  /** Free accounts at or past the cap. The conversion question, with names on it. */
  atCap: CapAccount[];
  /** Free accounts within 10% of it. Who is about to face the decision. */
  nearCap: CapAccount[];
  /** Counts by band, so the cap can be judged against where people actually sit. */
  distribution: Array<{ band: string; accounts: number }>;
  /** Free accounts that hit the wall and later started paying. */
  convertedAfterBlock: number;
  /** Hit the wall, never upgraded, and have been stuck 30+ days. */
  stalledAtCap: CapAccount[];
};

/**
 * The single most direct evidence about whether 100 is the right number.
 *
 * The interesting row is not "who is at the cap" — it is **who has been at the cap for a
 * month and did not upgrade**. That account has met the paywall, considered it, and
 * declined; enough of them means the cap is annoying people rather than converting them,
 * which is the opposite of what a limit is for.
 */
export async function contactCapPicture(
  rows: AdminUserRow[],
  now: Date = new Date()
): Promise<ContactCapPicture> {
  const db = await getDb();

  // When each account first met the wall, and how often since.
  const blocks = await db.execute(sql`
    SELECT user_id,
           min(created_at) AS first_at,
           count(*)::int   AS n
    FROM gate_events
    WHERE feature = 'contacts'
    GROUP BY user_id
  `);

  const blockMap = new Map<string, { firstAt: Date | null; n: number }>();
  for (const r of rowsOf<{ user_id: string; first_at: string | Date | null; n: number }>(
    blocks
  )) {
    blockMap.set(r.user_id, { firstAt: toDate(r.first_at), n: num(r.n) });
  }

  const decorate = (row: AdminUserRow): CapAccount => {
    const block = blockMap.get(row.userId);
    return {
      userId: row.userId,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      contacts: row.counts.contacts,
      firstBlockedAt: block?.firstAt ?? null,
      blockedCount: block?.n ?? 0,
    };
  };

  const free = rows.filter((r) => r.plan === "free");
  const nearThreshold = Math.floor(FREE_CONTACT_LIMIT * 0.9);

  const atCap = free
    .filter((r) => r.counts.contacts >= FREE_CONTACT_LIMIT)
    .map(decorate)
    .sort((a, b) => b.contacts - a.contacts);

  const nearCap = free
    .filter(
      (r) =>
        r.counts.contacts >= nearThreshold && r.counts.contacts < FREE_CONTACT_LIMIT
    )
    .map(decorate)
    .sort((a, b) => b.contacts - a.contacts);

  // Bands rather than a histogram: at this size a histogram is a bar chart of ones.
  const bands: Array<[string, (n: number) => boolean]> = [
    ["0", (n) => n === 0],
    ["1–9", (n) => n >= 1 && n < 10],
    ["10–49", (n) => n >= 10 && n < 50],
    [`50–${FREE_CONTACT_LIMIT - 1}`, (n) => n >= 50 && n < FREE_CONTACT_LIMIT],
    [`${FREE_CONTACT_LIMIT}+`, (n) => n >= FREE_CONTACT_LIMIT],
  ];
  const distribution = bands.map(([band, test]) => ({
    band,
    accounts: free.filter((r) => test(r.counts.contacts)).length,
  }));

  // Did meeting the wall actually convert anyone? Paid accounts that have a refusal on
  // record met the cap while free and upgraded afterwards.
  const convertedAfterBlock = rows.filter(
    (r) => r.plan !== "free" && blockMap.has(r.userId)
  ).length;

  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const stalledAtCap = atCap.filter(
    (a) =>
      a.firstBlockedAt !== null &&
      now.getTime() - a.firstBlockedAt.getTime() > THIRTY_DAYS
  );

  return {
    limit: FREE_CONTACT_LIMIT,
    atCap,
    nearCap,
    distribution,
    convertedAfterBlock,
    stalledAtCap,
  };
}

export type GateDemand = {
  feature: string;
  /** Distinct accounts refused. The adoption-shaped number. */
  accounts: number;
  /** Total refusals. Bouncing off repeatedly is a stronger signal than trying once. */
  hits: number;
  lastAt: Date | null;
};

/**
 * Which walls people actually hit.
 *
 * Sorted by distinct accounts rather than by hit count, for the same reason the adoption
 * table is: one determined user retrying twenty times is intensity, not demand. Both
 * columns render so the difference is visible.
 */
export async function gateDemand(days = 90): Promise<GateDemand[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT feature,
           count(DISTINCT user_id)::int AS accounts,
           count(*)::int                AS hits,
           max(created_at)              AS last_at
    FROM gate_events
    WHERE created_at > now() - make_interval(days => ${days})
    GROUP BY feature
    ORDER BY accounts DESC, hits DESC
  `);

  return rowsOf<{
    feature: string;
    accounts: number;
    hits: number;
    last_at: string | Date | null;
  }>(result).map((r) => ({
    feature: r.feature,
    accounts: num(r.accounts),
    hits: num(r.hits),
    lastAt: toDate(r.last_at),
  }));
}

/**
 * Paid accounts actually using each gated feature.
 *
 * Measured from durable artifacts rather than from `usage_events`, because most of these
 * features leave no AI call — a recruiter link, a campaign and a mailbox connection are
 * all things a user *made*, and counting them is both cheaper and truer than inferring
 * activity from model spend.
 *
 * `extension` maps to null on purpose. Nothing distinguishes an extension-sourced write
 * from an in-app one, so there is no honest number — and null renders as "not measured"
 * rather than as a zero that would read as "nobody uses it".
 */
export async function paidFeatureUsage(): Promise<Map<string, number | null>> {
  const db = await getDb();

  // Paid accounts only. Comps count as paid here: the question is "does anyone with access
  // use it", not "does anyone pay for it".
  const result = await db.execute(sql`
    WITH paid AS (
      SELECT user_id FROM user_settings
      WHERE comped_plan IS NOT NULL
         OR lifetime_purchased_at IS NOT NULL
         OR (subscription_plan = 'orbit'
             AND (subscription_status IN ('active', 'past_due')
                  OR subscription_period_end > now()))
    )
    SELECT
      (SELECT count(DISTINCT c.user_id)::int FROM outreach_campaigns c
         JOIN paid ON paid.user_id = c.user_id)                       AS outreach,
      (SELECT count(DISTINCT c.user_id)::int FROM outreach_campaigns c
         JOIN outreach_prospects p ON p.campaign_id = c.id
         JOIN outreach_messages m ON m.prospect_id = p.id
         JOIN paid ON paid.user_id = c.user_id
        WHERE m.status = 'sent')                                      AS hosted_sending,
      (SELECT count(DISTINCT u.user_id)::int FROM usage_events u
         JOIN paid ON paid.user_id = u.user_id
        WHERE u.operation IN ('outreach.apollo', 'import.enrich')
          AND u.key_owner = 'orbit')                                  AS hosted_enrichment,
      (SELECT count(DISTINCT l.user_id)::int FROM user_recruiter_links l
         JOIN paid ON paid.user_id = l.user_id)                       AS recruiters,
      (SELECT count(*)::int FROM paid WHERE user_id IN (
          SELECT user_id FROM gmail_connections
          UNION SELECT user_id FROM outlook_connections
          UNION SELECT user_id FROM calendar_subscriptions))          AS sync
  `);

  const row = rowsOf<Record<string, number>>(result)[0] ?? {};

  return new Map<string, number | null>([
    ["outreach", num(row.outreach)],
    ["hostedSending", num(row.hosted_sending)],
    ["hostedEnrichment", num(row.hosted_enrichment)],
    ["recruiters", num(row.recruiters)],
    ["sync", num(row.sync)],
    // No signal distinguishes an extension write from an in-app one.
    ["extension", null],
  ]);
}

/** The gated features, and what they are worth knowing about. */
export const GATED_FEATURES = [
  "outreach",
  "hostedSending",
  "hostedEnrichment",
  "recruiters",
  "sync",
  "extension",
] as const;

export type TierFinding = {
  feature: string;
  demandAccounts: number;
  /** Paid accounts that have actually used it. Null when usage is not separately tracked. */
  usedByPaid: number | null;
  verdict: "wanted" | "unwanted" | "unproven";
  note: string;
};

/**
 * Is anything in the wrong tier?
 *
 * Two mirror-image findings, and the second is the one that gets missed:
 *
 *   WANTED — free users keep hitting this wall. They are telling you what they would pay
 *   for, in the only way the product lets them.
 *
 *   UNWANTED — nobody has ever hit the wall AND no paying account uses it. A feature
 *   locked behind a tier that neither cohort touches is not a differentiator; it is either
 *   in the wrong tier or not worth its maintenance.
 *
 * `unproven` is deliberate rather than a lazy default: with a dozen accounts, "no evidence
 * either way" is the honest verdict for most features, and forcing every row into wanted
 * or unwanted would manufacture confidence the data does not support.
 */
export function tierFindings(
  demand: GateDemand[],
  paidUsageByFeature: Map<string, number | null>
): TierFinding[] {
  const byFeature = new Map(demand.map((d) => [d.feature, d]));

  return GATED_FEATURES.map((feature): TierFinding => {
    const demandAccounts = byFeature.get(feature)?.accounts ?? 0;
    const raw = paidUsageByFeature.get(feature);
    const usedByPaid = raw === undefined ? 0 : raw;

    if (demandAccounts > 0) {
      return {
        feature,
        demandAccounts,
        usedByPaid,
        verdict: "wanted",
        note: `${demandAccounts} free account${demandAccounts === 1 ? "" : "s"} hit this wall`,
      };
    }

    // Unmeasurable is not the same as unused, and must never render as a zero.
    if (usedByPaid === null) {
      return {
        feature,
        demandAccounts,
        usedByPaid: null,
        verdict: "unproven",
        note: "no usage signal exists for this feature, and nobody has hit its wall",
      };
    }

    if (usedByPaid === 0) {
      return {
        feature,
        demandAccounts,
        usedByPaid,
        verdict: "unwanted",
        note: "nobody has asked for it and no paying account uses it",
      };
    }

    return {
      feature,
      demandAccounts,
      usedByPaid,
      verdict: "unproven",
      note: `used by ${usedByPaid} paying account${usedByPaid === 1 ? "" : "s"}, never requested by a free one`,
    };
  });
}
