# Orbit unit-economics model

A transparent, dependency-free model of what one Orbit account costs per month, by plan and
usage profile, and what that means at 100 / 1,000 / 10,000 / 50,000 accounts.

```
node cost/unit-economics/model.mjs                    # today: included AI paused, Deepgram 2x opt-out premium
node cost/unit-economics/model.mjs --mip 1            # Deepgram at list price (if your invoice says so)
node cost/unit-economics/model.mjs --managed-ai on    # what resuming included AI would cost
node cost/unit-economics/model.mjs --inputs mine.json # your own copy of the inputs
```

It prints a report and writes `output/report.md` plus one CSV per table (`cost_per_user`,
`margin_subscriptions`, `lifetime`, `free_cost`, `scale`, `spend_by_category`,
`sensitivity`). The CSVs open in any spreadsheet. No network, database or secrets are read.

## Files

| File | What it is |
|---|---|
| `inputs.json` | Every number. Nothing in `model.mjs` is a price. |
| `model.mjs` | The arithmetic. About 300 lines, top to bottom: per-user cost → revenue net of Stripe → Lifetime → Free → scale points and cliffs → break-even → sensitivity. |
| `output/` | Generated. Safe to delete; rerun to recreate. |
| `../reconcile/` | The monthly check of the admin cost screens against real invoices. |

## How each number is labelled

Every entry in `inputs.json` carries a `status`:

- **CONFIRMED**: read from the vendor's own published source on the `checked` date (Neon, GitHub Actions, Anthropic, Sentry overage).
- **UNCONFIRMED**: this session's network policy blocked the vendor's pricing page, so the number is a search excerpt from the vendor's own domain. Open `url`, correct `value`, set `status` to CONFIRMED and today's date in `checked`.
- **MEASURED**: measured in this repo on seeded data (database bytes per contact and per embedding).
- **CODE**: read from Orbit's source (`src/lib/plans/plan-config.ts`, `ops.yml`, ...).
- **GUESS**: an assumption. These drive most of the answer. Replace them with the queries below.

The report ends with a list of every GUESS it used.

## Updating the inputs

### 1. Prices (once a quarter, and whenever a vendor emails about pricing)

Open each `url` in `inputs.json` under `rates` and check the number. The ones that matter most,
in order:

1. `rates.deepgram.*`. Speech-to-text is ~90% of variable cost. Your Deepgram invoice settles the
   biggest open question: every request sends `mip_opt_out=true`, and third-party reviews say that
   forfeits a 50% discount. Divide the month's Deepgram charge by its billed minutes (the
   reconciliation script prints this) and set `mipOptOutMultiplier` to `effective rate / list rate`.
2. `rates.neon.plan` and `rates.neon.minCu`: Neon console → Billing (plan) and → Branch →
   Compute (min/max CU, scale to zero).
3. `rates.vercel.*`: Vercel → Settings → Billing → Usage.
4. `rates.resend.*`, `rates.clerk.*`, `rates.stripe.*`.

### 2. Real usage (monthly). Run these yourself, read-only

Run against a Neon **read-only role or a fresh branch**, not your app role. Paste only the
aggregate numbers into `inputs.json`; never commit query output (the repo is public).

**Query 1: accounts per plan** → `mix.planShare`, `mix.lifetimeHolders`, `plans.annualShare`

```sql
select
  case
    when comped_plan is not null then 'comp:' || comped_plan
    when lifetime_purchased_at is not null then 'lifetime'
    when subscription_plan in ('orbit','max')
         and (subscription_status = 'active' or subscription_period_end > now())
      then subscription_plan || ':' || coalesce(subscription_interval, 'month')
    else 'free'
  end as plan,
  count(*) as accounts
from user_settings
group by 1 order by 2 desc;
```

**Query 2: speech minutes per account last month** → `profiles.*.meetingShare / shortformShare`

```sql
with m as (
  select user_id, kind, sum(seconds) / 60.0 as minutes
  from speech_usage
  where created_at >= date_trunc('month', now()) - interval '1 month'
    and created_at <  date_trunc('month', now())
  group by 1, 2
)
select kind, count(*) as accounts_using,
       percentile_cont(0.5)  within group (order by minutes) as p50,
       percentile_cont(0.9)  within group (order by minutes) as p90,
       percentile_cont(0.99) within group (order by minutes) as p99,
       max(minutes) as max, sum(minutes) as total
from m group by kind;
```

Compare `total` with Deepgram's billed minutes for the same month. A gap above ~10% is
unmetered streaming (see COST_AUDIT.md U1).

**Query 3: database size and the embedding duplicate** → `storage.*`

```sql
select relname, pg_size_pretty(pg_total_relation_size(relid)) as total,
       pg_total_relation_size(relid) as bytes
from pg_stat_user_tables order by bytes desc limit 20;

select count(*) as rows,
       avg(pg_column_size(embedding))        as jsonb_bytes,
       avg(pg_column_size(embedding_vector)) as vector_bytes,
       pg_size_pretty(pg_indexes_size('contact_embeddings')) as indexes
from contact_embeddings;
-- repeat for memory_chunks
select count(*)::float / nullif((select count(*) from contacts), 0) as embeddings_per_contact
from contact_embeddings;
```

**Query 4: contacts per account** → `profiles.*.contacts`

```sql
with c as (select user_id, count(*) n from contacts group by 1)
select percentile_cont(array[0.5, 0.9, 0.99]) within group (order by n), max(n), count(*) from c;
```

**Query 5: Orbit-paid AI by provider and month** → `--managed-ai on` sanity check

```sql
select provider, date_trunc('month', created_at) as month,
       sum(estimated_cost_micros) / 1e6 as usd, count(*) as calls
from usage_events where key_owner = 'orbit'
group by 1, 2 order by 2 desc, 1;
```

**Query 6: monthly active accounts** → `mix.monthlyActiveShare`

```sql
select count(distinct user_id) from page_views
where user_id is not null and not is_bot and not is_internal
  and created_at > now() - interval '30 days';
```

Vendor dashboards for the rest: Vercel → Usage (function invocations, CPU-hours, CDN requests:
`hosting.*`), Resend → Emails (monthly volume, `profiles.*.emails`), Sentry → Stats (errors per
month, `rates.sentry.errorsPer1000Mau`), Clerk → Users (monthly retained users).

## Reconciliation export

`cost/reconcile/reconcile.mjs` compares typed-in invoices with an export of the admin tables.
Build the export with these read-only queries for the month (replace `'2026-09-01'`):

```sql
-- infraCosts
select provider, amount_cents from infra_costs where period_month = '2026-09-01';
-- speechSeconds
select kind, sum(seconds) from speech_usage
where created_at >= '2026-09-01' and created_at < '2026-10-01' group by kind;
-- orbitAiMicros
select provider, sum(estimated_cost_micros) from usage_events
where key_owner = 'orbit' and created_at >= '2026-09-01' and created_at < '2026-10-01' group by provider;
```

`stripe` (gross, charge count, recurring share) comes from Stripe, not the database:
`billing_events` records MRR movements (new, expansion, churn), not charges. Use Stripe →
Payments, filtered to the month and status Succeeded → Export, and sum the amounts; count
the rows; `recurringCents` is the part that came from subscription invoices.

Put the results in a JSON file shaped like `cost/reconcile/example/admin-export.json`, and the
invoices in one shaped like `example/invoices.json`. Keep both outside git, then run:

```
node cost/reconcile/reconcile.mjs ~/orbit-private/2026-09-invoices.json ~/orbit-private/2026-09-export.json
```

## What the model leaves out (on purpose)

- Taxes, chargebacks, refunds, and your own time.
- Web-search fees on included AI (not metered in code: `src/lib/ai.ts` web search).
- Outreach SMS/email on Orbit's Twilio/Resend keys: not shipped (coming-soon).
- Apollo: bring-your-own-key on every plan, so $0 to Orbit.
- Neon compute load is a rough 40 CU-hours per 1,000 MAU above the floor; replace it with
  Neon → Monitoring once you have a month of real traffic.
