-- Draft reconciliation checks. Each query returns rows ONLY when something is wrong, so a
-- scheduled job can alarm on "any rows". Written against the current schema; column names
-- marked (proposed) do not exist yet and come from ANALYTICS_PLAN.md phase 1/2.
--
-- Never run against production from a laptop; the intended home is a CRON_SECRET-guarded
-- ops route that posts counts (not rows) to Slack.

-- R1a. Ledger MRR vs live MRR (what the /admin/billing drift panel shows), as a single row.
WITH ledger AS (
  SELECT coalesce(sum(mrr_delta_cents), 0)::bigint AS cents FROM billing_events
),
live AS (
  SELECT coalesce(sum(
    CASE
      WHEN comped_plan IS NOT NULL THEN 0
      WHEN subscription_plan NOT IN ('orbit', 'max') THEN 0
      WHEN subscription_status IN ('active', 'past_due', 'trialing') THEN coalesce(subscription_monthly_cents, 0)
      WHEN subscription_status = 'canceled' AND subscription_period_end > now() THEN coalesce(subscription_monthly_cents, 0)
      ELSE 0
    END), 0)::bigint AS cents
  FROM user_settings
)
SELECT 'ledger_vs_live_mrr' AS check_name, ledger.cents AS ledger_cents, live.cents AS live_cents,
       ledger.cents - live.cents AS drift_cents
FROM ledger, live
WHERE ledger.cents <> live.cents;

-- R1b. Subscribers in user_settings with no positive MRR row ever (a missed webhook or a comp
--      that should not read as a subscription).
SELECT 'subscriber_without_ledger' AS check_name, s.user_id, s.subscription_plan, s.subscription_status
FROM user_settings s
WHERE s.subscription_plan IN ('orbit', 'max')
  AND s.subscription_status IN ('active', 'past_due', 'trialing')
  AND s.comped_plan IS NULL
  AND NOT EXISTS (SELECT 1 FROM billing_events b WHERE b.user_id = s.user_id AND b.mrr_delta_cents > 0);

-- R1c. Ledger says the account still carries MRR, but the account row is gone (the self-deletion
--      drift in audit M2). Groups by user so the alarm names a count.
SELECT 'ledger_mrr_for_missing_account' AS check_name, b.user_id, sum(b.mrr_delta_cents) AS open_cents
FROM billing_events b
WHERE b.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM user_settings s WHERE s.user_id = b.user_id)
GROUP BY b.user_id
HAVING sum(b.mrr_delta_cents) <> 0;

-- R1d. Subscription monthly cents missing on a live subscriber (falls back to the legacy $5 today).
SELECT 'subscriber_missing_monthly_cents' AS check_name, user_id, subscription_plan
FROM user_settings
WHERE subscription_plan IN ('orbit', 'max')
  AND subscription_status IN ('active', 'past_due', 'trialing')
  AND subscription_monthly_cents IS NULL;

-- R2. Funnel "paid" vs Money "subscribed" populations: accounts counted paid by the funnel
--     rule (any positive MRR or a lifetime purchase, net of full refund) that are neither a
--     live subscriber nor a Lifetime holder. Expected to be non-empty for churned accounts;
--     the alarm is on growth of this count week over week, not on non-zero.
WITH paid AS (
  SELECT s.user_id,
         (s.lifetime_purchased_at IS NOT NULL OR bool_or(b.mrr_delta_cents > 0 OR b.kind = 'lifetime')) AS bought,
         sum(b.amount_cents) FILTER (WHERE b.kind IN ('lifetime', 'payment')) AS cash_in,
         sum(b.amount_cents) FILTER (WHERE b.kind = 'refund') AS refunded,
         s.subscription_plan, s.subscription_status, s.comped_plan
  FROM user_settings s
  LEFT JOIN billing_events b ON b.user_id = s.user_id
  GROUP BY s.user_id, s.lifetime_purchased_at, s.subscription_plan, s.subscription_status, s.comped_plan
)
SELECT 'funnel_paid_not_live' AS check_name, count(*) AS accounts
FROM paid
WHERE bought
  AND NOT (coalesce(cash_in, 0) > 0 AND coalesce(refunded, 0) >= cash_in)
  AND NOT (subscription_plan IN ('orbit', 'max') AND subscription_status IN ('active', 'past_due', 'trialing'))
  AND comped_plan IS DISTINCT FROM 'lifetime';

-- R3a. Signed-in page views whose user id no longer exists (purge should have nulled them).
SELECT 'page_views_orphan_user' AS check_name, count(*) AS rows
FROM page_views pv
WHERE pv.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM user_settings s WHERE s.user_id = pv.user_id)
HAVING count(*) > 0;

-- R3b. Waitlist rows that match an account by email but are not marked converted
--      (today "converted" is computed, not stored; after phase 2 compare to converted_at).
SELECT 'waitlist_email_matches_account' AS check_name, count(*) AS rows
FROM interest_list_signups il
WHERE EXISTS (SELECT 1 FROM user_settings u WHERE lower(u.email) = il.email)
  -- AND il.converted_at IS NULL   -- (proposed)
HAVING count(*) > 0;

-- R3c. Accounts with no first-touch attribution written (the API/MCP/extension-only gap, audit U2).
SELECT 'accounts_unattributed' AS check_name, count(*) AS accounts
FROM user_settings
WHERE signup_attributed_at IS NULL
  AND created_at < now() - interval '2 days'
HAVING count(*) > 0;

-- R3d. Internal accounts present in money: any billing row for an admin or showcase id.
--      Replace the list with ADMIN_USER_IDS / DEMO_ACCOUNT_USER_ID at run time.
-- SELECT 'internal_in_ledger' AS check_name, user_id, count(*) FROM billing_events
-- WHERE user_id IN (<internal ids>) GROUP BY user_id;

-- R4. Credit packs booked vs granted (mirrors the existing admin panel check).
SELECT 'packs_booked_vs_granted' AS check_name,
       (SELECT count(*) FROM billing_events WHERE kind = 'credit_pack') AS booked,
       (SELECT count(*) FROM credit_grants WHERE kind = 'pack') AS granted
WHERE (SELECT count(*) FROM billing_events WHERE kind = 'credit_pack')
   <> (SELECT count(*) FROM credit_grants WHERE kind = 'pack');

-- R5. Deepgram seconds that carry no cost anywhere (audit M4): a reminder that speech_usage
--     is unpriced until phase 1.10 lands. Returns the month's unpriced seconds.
SELECT 'unpriced_speech_seconds' AS check_name, sum(seconds) AS seconds
FROM speech_usage
WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
HAVING sum(seconds) > 0;
