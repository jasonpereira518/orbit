# privacy/: audit probes (draft, Phase 1)

These scripts back the "verified" findings in [`PRIVACY_AUDIT.md`](../PRIVACY_AUDIT.md). They do
not change application code.

**Safety.** Every probe that touches a database imports `scripts/smoke/_env` first. That module:
- deletes `DATABASE_URL`, so `getDb()` falls back to PGlite;
- points PGlite at a fresh throwaway directory;
- strips every billable provider key.

The probes never reach Neon, Stripe, Clerk or any AI provider. All data is synthetic.

| Probe | What it verifies | Output |
|---|---|---|
| `probe-schema-inventory.ts` | Lists every table in the live bootstrapped schema. Shows which are `user_id`-scoped, which reference a person by another column, which hold identifier or prose columns, and which are in the export registry. | `out/schema-inventory.json` |
| `probe-account-deletion.ts` | Seeds a row in almost every table for three fake users. Deletes user A through Settings (`deleteOwnAccount`, vendor calls recorded) and user C through a correctly signed Clerk `user.deleted` webhook sent to the real route. Then scans the whole database for anything still carrying A's or C's id or email, and checks bystander B is untouched. | `out/account-deletion.json` |
| `probe-selective-deletion.ts` | Covers four cases: deleting one contact, deleting one interaction, reverting an import, and purging insights followed by an unmerge (the resurrection test). | `out/selective-deletion.json` |
| `probe-export.ts` | Checks the export: 16 categories, isolation between users, the tables it omits, credential redaction, and timing for a 20k-contact / 60k-interaction account. | `out/export.json` |
| `probe-log-scrub.ts` | Runs a realistic `DrizzleQueryError` through the real Sentry scrubber. No database. | `out/log-scrub.json` |

`lib/seed-everything.ts` is a catalog-driven seeder. Every text value it writes contains the
owning user's id, so `row::text LIKE '%<id>%'` finds every surviving copy, by table and column,
without a hand-kept list.

Run (Node 24, after `npm ci`):

```sh
npx tsx privacy/probe-schema-inventory.ts
npx tsx privacy/probe-account-deletion.ts
npx tsx privacy/probe-selective-deletion.ts
npx tsx privacy/probe-export.ts
npx tsx privacy/probe-log-scrub.ts
```

These are diagnostic probes, not pass/fail tests. Several print findings that are known gaps
today. Phase 1 of [`PRIVACY_PLAN.md`](../PRIVACY_PLAN.md) proposes turning each into an
asserting `scripts/smoke-*.ts` once the matching fix lands.
