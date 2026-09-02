# Archived one-off migrations

These scripts each applied one schema change to production by hand, before the DDL
template in `src/db/index.ts` carried it. Every change they made is now in the template
(or the `alters` list) and is applied by `npm run db:migrate` during the Vercel build, so
none of them needs to run again. They are kept for the record — what changed, when, and
why — not as tooling.

**The rule from here on:** additive DDL goes in the template or `alters`, with a
`SCHEMA_VERSION` bump and `npx tsx scripts/smoke-schema-ddl.ts --update`. Never a new
`migrate-*.ts`. The build-time migration and `scripts/smoke-schema-upgrade.ts` prove the
change on a fresh database and on one a version behind.

| Script | What it added |
|---|---|
| `migrate-admin-tables.ts` | admin_audit_log and friends |
| `migrate-admin-v2.ts` | admin console indexes (`ADMIN_V2_STATEMENTS`) |
| `migrate-billing-columns.ts` | Stripe mirror columns on user_settings |
| `migrate-contacts-columns.ts` | school, profile_image_url, x_handle on contacts |
| `migrate-embedding-stale.ts` | contacts.embedding_stale_at + the embeddings unique index |
| `migrate-identity-columns.ts` | email / name / avatar mirror on user_settings |
| `migrate-instrumentation-tables.ts` | usage_events, error_events, webhook_deliveries, cron_runs |
| `migrate-recruiter-messages.ts` | recruiter_messages |
| `migrate-recruiter-sharing.ts` | user_recruiter_links sharing columns |
| `migrate-startup-instrumentation.ts` | gate_events, feedback, billing_events |
| `migrate-stated-closeness.ts` | contacts.stated_closeness |

`scripts/migrate-avatars-to-blob.ts` is different: a DATA migration (inline avatars →
Blob) that runs once after Blob storage is provisioned. It stays in `scripts/`.
