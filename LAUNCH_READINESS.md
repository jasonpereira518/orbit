# Orbit launch readiness: go/no-go review

**Date:** 2026-10-17
**Commit reviewed:** `bf1b4aeac9987509afc429dfe0687bf93270d731` (origin/main)
- CI run 38983538008: **success**
- GitHub Deployments API: Production deployment of this SHA, 2026-10-16 23:53 UTC, `success`
- Ops log: `/api/health` reported `sha bf1b4ae`, schema 170/170

**Proposed release candidate:** `rc-1` = `bf1b4ae` plus the merges in [`LAUNCH_PLAN.md`](LAUNCH_PLAN.md) §0. It doesn't exist yet. This review applies to `bf1b4ae`. Re-run the local gate on `rc-1` before relying on it.

**Method.** Seven parallel audits (merge state, billing, identity, security, copy/legal/email, local execution, ops). I re-checked every finding below that carries a FAIL or a blocker myself against code, a run, or the GitHub API. Two sub-agent claims did not survive and were corrected:
- The backup artifacts are not byte-identical; their digests differ.
- The `npm ci` lockfile failure happens only under Node 22, not the pinned Node 24.

No production system, production data or secret was touched. To check backup run history, I attached the private `jasonpereira518/orbit-ops` repository read-only. No application code or settings were changed.

**Status key:**

| Status | Meaning |
|---|---|
| **VERIFIED** | I or a sub-agent saw it work (a run, a smoke, a log, an API record). Evidence is cited. |
| **VERIFIED-FAIL** | Exercised and shown broken or absent. |
| **CLAIMED** | A document or code comment says so, but nobody exercised it. |
| **UNKNOWN** | Needs a dashboard or production access I don't have. The steps are in §5. |

Only VERIFIED passes. Owner is "Jason" unless stated. Severity is the impact if the item is failed or left unknown at the stage it gates.

---

## 1. Verdicts

| Stage | Verdict | Blocking items |
|---|---|---|
| **(a) Invite a small first wave** (~10–25 trusted people, invite-only) | **GO WITH CONDITIONS** | Do these first (about 2–3 days, mostly console work; LAUNCH_PLAN §0–§1):<br>1. Merge the security Phase 1 branch (S-01, P-05).<br>2. One restore drill (D-03).<br>3. Pin the backup runner before Oct 19 (D-02).<br>4. Backup heartbeat set (D-04).<br>5. A test alert reaches your phone (O-02).<br>6. Clerk Restricted mode, with stealth saved once (I-01, I-02).<br>7. Invitees added as Google test users, or the Gmail surfaces hidden (I-05).<br>8. Invite copy matches the included-AI switch (C-02).<br>9. Runbook rollback and refund order corrected (O-06, B-04).<br>10. A support channel shown to deliver (U-01).<br><br>#457 (scheduler) is strongly recommended for wave 1 and required for wave 2. |
| **(b) Invite larger waves** | **NO-GO** today. Becomes GO WITH CONDITIONS once (a) is done and these hold:<br>• wave 1 meets the exit criteria (LAUNCH_PLAN §1)<br>• the scheduler is on QStash and has run on time for 7 days (O-01)<br>• MCP scopes are enforced (S-02)<br>• Google sensitive-scope verification is submitted, and total Google-connected users stay under the 100-user cap (I-04)<br>• copy mismatches are fixed (C-01..C-06)<br>• processor list corrected (C-08)<br>• known-issues list published (U-03)<br>• Clerk-outage and owner-unavailable runbooks exist (O-07) | |
| **(c) Open public sign-up** | **NO-GO** | • Google verification complete, and restricted Gmail/Drive scopes gated in code (I-04, I-06)<br>• Lawyer review (C-07)<br>• Load test at the launch target (P-08)<br>• Vercel Pro (H-01)<br>• CAN-SPAM postal address and SPF/DKIM/DMARC confirmed (E-02, E-01)<br>• Status page (U-02)<br>• Least-privilege DB role (S-04)<br>• CSP enforced (S-03)<br>• Dependabot alerts and secret scanning on (S-08)<br>• Everything in (b) |
| **(d) Charge money** | **NO-GO** | • Vercel Pro: Hobby forbids commercial use (H-01)<br>• Paywall bypass H-01 still on `main` (S-01)<br>• Refund-then-cancel re-grants Pro (B-04, reproduced)<br>• Refund ledger likely wrong on current Stripe payloads (B-05)<br>• Stripe live dashboard unverified: webhook events, portal, business name, dunning (B-01, B-06..B-08)<br>• No tax decision (B-10)<br>• No lawyer review (C-07)<br>• Money acceptance run never done (P-02)<br><br>**Today, live checkout is reachable by any invited account** (an `sk_live_` key is required in prod builds, `env.ts:182-188`). There is no pause-sales switch (B-14). Until this row is GO, don't direct invitees to `/upgrade`. |

---

## 2. Gate table

### R. Release state

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| R-01 | The SHA in production equals the SHA under review | VERIFIED | Deployments API: Production `bf1b4ae` 2026-10-16 23:53Z. ops run 39007234746 log: `/api/health` sha bf1b4ae, schema 170/170. | — | — |
| R-02 | CI green on the candidate | VERIFIED | ci.yml run 38983538008 on `bf1b4ae`: success. Also green on eb5d69d, e8dbc59, 7b71464, 1d94b79. | — | — |
| R-03 | No launch-critical work stranded off `main` | VERIFIED-FAIL | • `claude/trusting-wozniak-ebsks3` (security H-01..H-05, pushed Oct 17, no PR).<br>• `claude/gallant-ramanujan-hh5j0s` (AI P0s including log PII).<br>• #457 (scheduler) and #460 (test gate) are open.<br>• #453's ~770 lines (`linkedin-export-extras.ts`, `linkedin-signals.ts`, `linkedin-export-apply.ts`) merged into an already-merged branch and are missing on `main` (`git cat-file` confirmed). | High | 1 d |
| R-04 | No schema-version collisions among pending work | VERIFIED-FAIL | • `trusting-wozniak` and `serene-cerf` both set `SCHEMA_VERSION = 171` (`src/db/index.ts:2729/2730` on each branch).<br>• Leads #266–#343 claim v121–v124 and email insights #386 claims v145. Both are below production's 170, so `isSchemaCurrent` (`src/db/index.ts:3373`) would skip them forever. | High (silent DDL skip) | 1 h per renumber |
| R-05 | Branch protection on `main` | VERIFIED-FAIL | The ci.yml header says there are no required checks. The protection API returned 403. #460 notes it is not enforced. | Med | 10 min |
| R-06 | Open PR hygiene | CLAIMED/OK | 49 open PRs, 39 of them on branches more than 14 days stale. Plan in LAUNCH_PLAN §0.2. | Low | 1 h |
| R-07 | Built-but-gated features match copy | see C-01 | Coming-soon by default (`src/lib/surfaces.ts`): radar :73, events :81, find :113, outreach :149, compose :268, outlook-send :276, reply-inbox :284, chat-imports :292, cloud-notes :301. Production overrides live in `app_surface_flags` and are UNKNOWN. | Med | — |

### D. Data safety

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| D-01 | Automated backups succeed on schedule, encrypted, stored separately | VERIFIED (since Oct 13 only) | `orbit-ops` backup runs 38484426926 (Oct 13, manual), 38551665251, 38720392105, 38885905614: all success. Artifacts are 248,571 / 248,571 / 416,523 / 416,523 bytes, with different digests, expiring in 90 days. Each is age-encrypted to a public key in a private repo (`backup.yml`). **All 33 runs of the old public-repo backup failed (0 successes, Sep 6 – Oct 14), so production had no backup before Oct 13 23:28 UTC.** The public repo holds no dump artifacts. Scheduled runs start 4h14m–4h44m after the 06:00 cron. | — | — |
| D-02 | Backup keeps working through the Oct 19 runner change | UNKNOWN (risk) | `backup.yml` uses `runs-on: ubuntu-latest` and installs from the PGDG apt script. GitHub moves `ubuntu-latest` to Ubuntu 26 on Oct 19 (annotation seen on CI runs). | High | 10 min |
| D-03 | Restore drill done, integrity checked | VERIFIED-FAIL (never done) | RUNBOOK drill log: "_not yet run_". `git log --all --grep=drill`: nothing. Equal artifact sizes a day apart, on a database the ops jobs write to, are unexplained until a restore. Whether the age private key exists in the password manager is UNKNOWN. | **Blocker (a)** | 2 h |
| D-04 | Backup failure or staleness reaches a human | VERIFIED-FAIL | Job 116923455758 log: `BETTERSTACK_BACKUP_HEARTBEAT_URL` empty → "not set, skipping". `backup.stale` (RUNBOOK:10) therefore doesn't exist. The failure page step has never run, so Slack in `orbit-ops` is UNKNOWN. | High | 15 min |
| D-05 | Point-in-time recovery window known | UNKNOWN | `backup.yml:9` assumes about 6 h ("verify it"). RUNBOOK:266 says only "Verify". | Med | 5 min |
| D-06 | Deletion protection on the Neon project and branch | UNKNOWN | No evidence anywhere. | Med | 5 min |
| D-07 | Migration safety: a failing migration doesn't go live | CLAIMED | `vercel.json` buildCommand `check:env && db:migrate && next build`, so a failed DDL fails the build (RUNBOOK:21). The never-downgrade rule is at `src/db/index.ts:3373-3458`. A real failing deploy has not been exercised. | Med | — |
| D-08 | Rollback safe across schema | VERIFIED-FAIL | RUNBOOK:31 says "Schema changes are additive". `src/db/index.ts` has `DROP TABLE IF EXISTS guest_profiles` (:4714, v170), `DROP COLUMN` (:2734, :2841, :2875, :4604, :4720) and `RENAME` (:3496, :4774). Code before v170 references `guest_profiles` in export and purge (removed in 124388f). | High | 1 h docs, plus a freeze rule |
| D-09 | Account deletion leaves zero rows | VERIFIED (local) | `smoke-purge` (101 checks) seeds every user-scoped table and asserts zero left. `smoke-account-deletion` and `smoke-delete-my-account` pass. The Clerk `user.deleted` path passes `keepSettings:false` (`webhooks/clerk/route.ts:122`). Not run against real Clerk. | — | — |

### H. Hosting and vendor terms

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| H-01 | Hosting plan allows commercial use | VERIFIED-FAIL (as of last evidence) | Sep 15 audit: "Verified: the team plan is `hobby` (Vercel API)". Still described as Hobby in `ops.yml:3`, `report-error.ts:10`, `perf-trace.ts:6`, `webhooks/dispatch.ts:16`. The launch changelog's R10 is "Blocked on D1". Nothing shows an upgrade. Vercel Hobby is personal, non-commercial use only. | **Blocker (d)** | 10 min + $20/mo |
| H-02 | Other vendor tiers fit the launch | UNKNOWN | Neon (likely free: a 6 h PITR assumption), Resend (the free tier caps at 100 emails/day), QStash (#457 needs Pay-as-you-go), Better Stack, Sentry. Check each plan page. | Med | 30 min |

### B. Billing (Stripe)

Local evidence for the B items:
- 17 billing smoke scripts pass, 17/17 in 52 s (stripe-ordering, stripe-revocation, stripe-webhook, stripe-dedupe, stripe-unattributed, pricing-v2-billing, billing-portal, subscription-management, checkout-confirm, admin-lifetime, entitlements, plan-enforcement, plan-downgrade, plan-upgrade-claim, plan-card-copy, credits, admin-credits).
- A pure-function probe I re-ran: `scratchpad/probe-refund-then-cancel.ts`.
- `smoke-stripe-testclock` (needs the Stripe sandbox) was **not** run.

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| B-01 | Live webhook endpoint subscribed to the handled events | UNKNOWN | Handled (`src/lib/billing-stripe.ts:572-1096`): checkout.session.completed and async_payment_succeeded; customer.subscription.created, updated and deleted; invoice.paid and payment_failed; charge.refunded; charge.dispute.created and closed. | High | 10 min |
| B-02 | Duplicate webhooks idempotent | VERIFIED | `stripe_processed_events.event_id` PK (schema.ts:6277). Unique `billing_events_source_event_uidx`. Smoke: a redelivery does not re-grant. | — | — |
| B-03 | Late or out-of-order webhooks | VERIFIED | `isStaleSubscriptionEvent` (billing-stripe.ts:560) plus a `GREATEST` clock. Smoke: "the late event … cancellation stands". | — | — |
| B-04 | Refund revokes access in the order the runbook prescribes | **VERIFIED-FAIL** | RUNBOOK:197-205 says refund the Pro charge, then cancel the subscription. `subscription_revoked` (`stripe-fulfilment.ts:188-197`) doesn't advance the event clock. The later `customer.subscription.deleted` writes `canceled` with the original period end. Probe: `after refund+cancel resolvePlan (+19 days): {"plan":"orbit","source":"subscription"}`. Cancel-then-refund works. Assumes Stripe keeps `current_period_end` on an immediate cancel. | **Blocker (d)** | 2 h |
| B-05 | Billing ledger books refunds correctly | UNKNOWN (likely fail) | Refund cash is booked only from `charge.refunds.data` (billing-stripe.ts:981). Current Stripe API versions omit that list from Charge payloads. Probe: a partial refund without the list books 0 rows. The smoke fixtures always include the list. | High (revenue numbers) | 2–4 h |
| B-06 | Customer portal configured | UNKNOWN | Code looks up the config tagged `orbit_config=pricing_v2` (stripe-prices.ts:65-77) and **silently falls back to the default portal**. The creation script is `scripts/stripe-pricing-v2.ts:296-325`. | High | 15 min |
| B-07 | Lapsed subscriptions lose access correctly | VERIFIED (behaviour) / UNKNOWN (dashboard) | past_due keeps access to the period end (entitlements.ts:132-137); unpaid or incomplete drops to Free at once. If Stripe *cancels* after failed retries, access runs to the end of the unpaid period (probe). The dashboard dunning setting decides which happens. | Med | 5 min |
| B-08 | Business name, receipts, statement descriptor | UNKNOWN | No `statement_descriptor` in code. The changelog says the sandbox shows "stripe-almond-grass". | Med | 15 min |
| B-09 | Access revoked on lost dispute | VERIFIED (local) | `charge.dispute.closed` with lost revokes (billing-stripe.ts:1057). smoke-stripe-revocation passes. An open dispute changes nothing. | — | — |
| B-10 | Sales tax / VAT handled | VERIFIED-FAIL (absent) | No `automatic_tax` or `tax_id_collection` anywhere. | High (legal) | 0.5 d + adviser |
| B-11 | Ledger reconciles to Stripe | VERIFIED-FAIL (no job) | `mrrReconciliation` compares ledger to the internal mirror, not to Stripe (billing-events.ts:367). `scripts/backfill-billing-events.ts` is manual only. | Med | manual weekly |
| B-12 | Comping a paying user is safe | VERIFIED-FAIL (code) | Comping doesn't touch Stripe (actions/admin.ts:71-113). Once comped, cancel and portal require source `subscription` (subscription-management.ts:138, billing-portal.ts:47), so the user keeps being billed with no self-serve exit. | Med | 1 h |
| B-13 | Buying Lifetime while on Pro | VERIFIED (not possible) | Lifetime isn't sold. Checkout refuses any non-Free account (actions/billing.ts:96-97). An admin Lifetime grant sets `cancel_at_period_end` with no refund (subscription-management.ts:286-305). Smoke covers it. | — | — |
| B-14 | Ability to pause sales without breaking subscribers | VERIFIED-FAIL (absent) | `isCheckoutConfigured()` = `Boolean(STRIPE_SECRET_KEY)` (stripe-config.ts:94). The same key powers cancel and the portal. | Med | 1 h |
| B-15 | Plan change Pro↔Max proration | UNKNOWN | Delegated to the portal config (subscription-management.ts:229-241). | Med | in B-06 |
| B-16 | In-app cancel / resume | VERIFIED (local) | smoke-subscription-management. Never run against Stripe. | — | — |

### C. Copy and legal

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| C-01 | Pricing, landing and in-app copy name only shipped features | VERIFIED-FAIL | C-02..C-06 below. The plan numbers are correct (all read from `plan-config.ts:137-198`). | High | 0.5 d |
| C-02 | "AI included" is true | VERIFIED-FAIL / UNKNOWN | Copy: `pricing/page.tsx:25, :43-45`, `plan-copy.ts:66, :99, :118`, `pricing-faq.tsx:24`. Code: `managedAiPausedDefault()` returns `VERCEL_ENV === "production"` (`ai-access.ts:181`), so production is **paused unless switched on**. The production switch state is UNKNOWN. | **Blocker (a)** for invite copy | 15 min |
| C-03 | Gmail promises | VERIFIED-FAIL | Landing: "Connect LinkedIn and Gmail once" (`landing-scenes.tsx:143`), "link Gmail — no manual entry" (`landing-how-it-works.tsx:34`), "Gmail threads … keeps every record current" (`scene-features.tsx:82`). On `main`, Gmail reading is only the Pro recruiter scan, plus event mail, which is coming soon. General mail sync is in open PRs #386–#399. Onboarding says the opposite: `connect-step.tsx:62` "Orbit can't read or send your mail". | High | 1 h |
| C-04 | Coming-soon pages promise "Unlocks with Orbit Pro" | VERIFIED-FAIL | `coming-soon.tsx:159` for Radar, Find, Events and Outreach. No Pro gate exists for Radar or Find. Radar says "every morning" (`coming-soon.tsx:34`), but the digest is weekly. | Med | 30 min |
| C-05 | Lifetime "Yours permanently" | VERIFIED-FAIL | `plan-settings.tsx:26` vs `plan-copy.ts:146-147` "for as long as Orbit exists". | Low | 5 min |
| C-06 | Waitlist perks backed by product | VERIFIED-FAIL | "founding member badge", "priority beta access" (`interest-list.ts:69, :83`; `interest-list-email.ts:357-375`): no implementation. "founding pricing" in the invite *is* backed (`site-invites.ts:225`). | Med | 1 h |
| C-07 | `/privacy` and `/terms` reviewed by a lawyer | VERIFIED-FAIL (no evidence) | `docs/pricing-v2/legal-proposal.md:3` shows only "APPLIED … with Jason's approval". The changelog has R3 "Blocked on D4". Operator is the individual "Jason Pereira", with no postal address and no named jurisdiction (`terms` ~:482). | **Blocker (c),(d)** | 1–2 wks elapsed |
| C-08 | Legal pages match behaviour | VERIFIED-FAIL | • Managed AI includes Gemini (`managed-ai-policy.ts:117`), but privacy:379 names only Anthropic and OpenAI.<br>• Resend is described as waitlist and outreach only (privacy:78), but it also sends invitations, credit notices, the Radar digest, broadcasts and the contact form.<br>• Slack also receives feedback snippets (`feedback-notify.ts:29-35`).<br>• Twilio falls back to Orbit's own account (`outreach-send.ts:51-59`).<br>• Terms :228 says Microsoft is "Outlook contacts" only.<br>• There is no GDPR/CCPA rights section.<br>• Backup retention of 90 days matches. | High | 0.5 d |
| C-09 | Google API Limited Use disclosure present | VERIFIED | `legal.ts:52-57`, rendered on privacy. `smoke-legal-pages` passes (57 checks). | — | — |
| C-10 | Terms-version re-acceptance works | VERIFIED (local) | `TERMS_VERSION="2026-10-16"` (`legal.ts:18`), strict `!==`. smoke-terms-acceptance: "an account on an older version sees it". **It's a banner, not a gate.** The API, extension and actions keep working without acceptance (layout.tsx:118-122). | Med (legal choice) | — |

### E. Email and SMS

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| E-01 | Sender domain verified (SPF, DKIM, DMARC) | UNKNOWN | DNS was unreachable from this sandbox: no `dig`, and DNS-over-HTTPS was refused. `RESEND_FROM_EMAIL` isn't pinned in code. The changelog (M3) said it *was* a gmail.com address and every waitlist welcome was rejected. | High | 15 min |
| E-02 | Postal address in bulk mail (CAN-SPAM) | VERIFIED-FAIL | A repo-wide grep finds none in any template. | **Blocker (c)** | 1 h |
| E-03 | Unsubscribe / List-Unsubscribe | CLAIMED | Waitlist (`interest-list-email.ts:484-489` plus a GET/POST route), broadcasts (`broadcasts.ts:196`), Radar digest (`radar/digest.ts:213`), credit notices (`credits/notices.ts:195`). Hosted outreach is reply-only (`outreach-send.ts:104-109`), but Outreach is coming soon. Not exercised. | Med | — |
| E-04 | Sending caps enforced server-side | CLAIMED | Recipient cap Free 40 / paid 200 per rolling 24 h (`email/config.ts:13-18`), enforced at `email/outbox.ts:169`. Outreach 50/day. The cap has its own smoke on `main` (not individually re-run here; the full suite passed in CI). | Med | — |
| E-05 | SMS opt-out | CLAIMED | "Reply STOP" (`outreach-send.ts:106`). Twilio Advanced Opt-Out and A2P 10DLC are UNKNOWN. Latent while Outreach is coming soon. | Low now | — |
| E-06 | Mail actually delivers on schedule | VERIFIED-FAIL | The email outbox drain rides the 10-minute schedule, which ran 7 times in about 24 h (see O-01). Interactive mail sends via `after()` once the undo window lapses; retries wait hours. | Med | via #457 |

### I. Identity and platform access

Local evidence: smokes terms-acceptance (17), site-access (27), waitlist-host (110), google-scopes (58), microsoft-scopes (83), purge (101), webhook-signing, webhook-guard, delete-my-account, account-deletion, legal-pages (57), oauth-refresh-rejection and oauth-return all pass.

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| I-01 | Sign-up restricted to invitees (Clerk mode) | UNKNOWN | `.env.example:250-254` says to also set Clerk to Restricted. The dashboard state is unseen. | **Blocker (a)** | 5 min |
| I-02 | Stealth mode and invitations bypass correctly | VERIFIED (logic) / UNKNOWN (prod) | The stealth gate (`waitlist-host.ts:278-337`) and the held-account rule (`site-access.ts:151-213`) pass smokes: "a Clerk invitation opens /sign-up", "a brand-new uninvited account is held". **Gap:** with only `SITE_STEALTH=1` there is no `stealth_since`, so nothing is held (`site-access.ts:20-22, 179`). It must be saved once in `/admin`. | High | 5 min |
| I-03 | `user.deleted` webhook wired and purges | VERIFIED (code + smoke) / UNKNOWN (subscription) | `webhooks/clerk/route.ts:122` → `purgeUserData(..., {keepSettings:false})`. Signature verified. There's no svix-id dedupe; the handlers are idempotent. | Med | 5 min |
| I-04 | Google OAuth verification and user cap | UNKNOWN | **Default Connect requests `contacts.readonly` + `calendar.readonly`, both sensitive** (`google-scopes.ts:12-58`). An unverified app shows Google's warning screen and is capped at 100 users. In Testing mode, only listed test users can connect, and refresh tokens expire after 7 days. Verification status isn't recorded anywhere in the repo. **The 101st user** cannot connect Google. The callback reads Google's `access_denied` as "connection cancelled" (`gmail/callback/route.ts:31-59`; `errors.ts:575-586`), so the user is told they cancelled. | **Blocker (c)**; condition (a), (b) | weeks (Google) |
| I-05 | Restricted scopes (gmail.readonly, gmail.send, drive.readonly) | VERIFIED-FAIL (gating) | Recruiter scan: hide `page.recruiters`. Event mail: `page.events` is coming soon. Drive: `feature.cloud-notes` is coming soon. **"Send from Gmail" (gmail.send) has no flag.** It shows on the Google account page (`google-account-page.tsx:178-203`) and in chat and follow-up send. `startGmailOAuth` does no surface check (`actions/gmail.ts:142-190`). | High | 0.5 d code |
| I-06 | Launch with limited integrations vs "unverified" warnings | Recommendation | Launch wave 1 with contacts and calendar only, and invitees listed as test users. Keep every restricted scope off the consent screen and out of the UI until CASA. Submit sensitive-scope verification now. A warning screen on the first click is survivable for friends but not for strangers, and the 100-user cap is per project, not per wave. | — | — |
| I-07 | Microsoft publisher verification | UNKNOWN | Tenant `common` (`outlook.ts:61-63`). Scopes are in `microsoft-scopes.ts:21-58`. Verification is mentioned only as a to-do. Without it, consent shows "unverified" and many work tenants block it. | Med | 1 h + wait |
| I-08 | Chrome Web Store requirements | Out of scope (VERIFIED hidden) | "Add to Chrome" renders only if `NEXT_PUBLIC_EXTENSION_URL` is set (`plan-copy.ts:62-63`). The store listing and disclosure exist only in open PR #254. The extension builds, lints and typechecks clean. | Low | — |
| I-09 | Clerk "Require express consent" | UNKNOWN | Changelog M9. | Med | 2 min |

### S. Security

Local evidence: smokes security-headers, action-user-scope (474 exported actions), cross-tenant-refs, ai-guardrails-db (29), admin-gate, internal-auth, rate-limit, mcp-server and drizzle-guard all pass.

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| S-01 | Known high-severity findings fixed on `main` | **VERIFIED-FAIL** | `claude/trusting-wozniak-ebsks3:SECURITY_AUDIT.md:165-169`:<br>• **H-01** paywall bypass: confirmed on `main`. `createContact(input, options?: ContactWriteOptions)` is an exported `"use server"` action (`src/actions/contacts.ts:685-690`), and `ContactWriteOptions` carries a caller-supplied `entitlements` and a remaining allowance (`src/lib/contact-writes.ts:58-100`).<br>• **H-02** aborted managed-AI streams cost zero credits.<br>• **H-03** one RRULE hangs the shared sync worker.<br>• **H-04** two import runners double contacts.<br>• **H-05** a half-failed capture is reported as saved.<br>The fixes are on that branch with smokes. No PR, no CI. | **Blocker (a)** (H-03/04/05), **(d)** (H-01/02) | 1 d incl. CI |
| S-02 | MCP connector OAuth scope enforcement | VERIFIED-FAIL (default) | `oauthGrantFor` (`src/lib/mcp/oauth.ts:58-66`): a token with no Orbit scope gets `OAUTH_CALLER_SCOPES` (read+write) unless `MCP_OAUTH_REQUIRE_SCOPES=1`. Run directly: `["openid","email"]` → `["read","write"]`. Prod env is UNKNOWN. Tool-level gating itself works (smoke-mcp-server). | High | 1 h |
| S-03 | CSP enforced | UNKNOWN (code default: report-only) | `next.config.ts:36` `enforce: process.env.CSP_ENFORCE === "1"`. `script-src 'unsafe-inline'` is always on (`security-headers.ts:58`). | Med | 1 h + week of reports |
| S-04 | Least-privilege database role | VERIFIED-FAIL | No `CREATE ROLE`/`GRANT` anywhere. One `DATABASE_URL` both serves traffic and runs DDL (`src/db/index.ts:4801-4831`). No row-level security. | Med | 0.5–1 d |
| S-05 | Tenant isolation tests | VERIFIED | smoke-action-user-scope: no exported action takes a user id from the caller (474 checked). cross-tenant-refs and ai-guardrails-db pass. | — | — |
| S-06 | Rate limiting | VERIFIED (impl) | Postgres fixed window, which holds across instances (`rate-limit.ts:7-17`). It covers waitlist, MCP, REST, extension, chat, capture, research, export and contact. smoke-rate-limit passes. Every check is a DB write, which adds load during a spike. | Low | — |
| S-07 | Security headers | VERIFIED (code + smoke) | HSTS 2 y, XFO DENY + `frame-ancestors 'none'`, COOP, Referrer-Policy, Permissions-Policy, `poweredByHeader:false`. Production response headers were not fetched. | — | — |
| S-08 | Secrets in git history | VERIFIED (regex) | Full-history bare clone, 3,091 commits, 16 key patterns. All 12 hits are placeholders. `.env*` is ignored. gitleaks/trufflehog weren't available. **Dependabot alerts are disabled** (API 403) and secret-scanning status is unknown. #460 mentions two gitleaks hits to triage. | Med | 1 h |
| S-09 | Dependency vulnerabilities | VERIFIED (accepted) | `npm audit --omit=dev`: root 0 critical, 15 high, 11 moderate; extension 1 critical (`shell-quote`), 15 high. All are on the `@clerk/ui` → Solana wallet-adapter → react-native chain or build-only tools, none loaded at runtime. next 16.3.8 has no advisory. | Low | — |
| S-10 | Secret comparison, admin gate, SSRF, uploads | VERIFIED | CRON/HEALTH via `timingSafeEqual` (`internal-auth.ts`). Admin = `ADMIN_USER_IDS`, non-admins get a 404 (smoke-admin-gate). `net-guard.ts` blocks metadata, loopback and RFC1918 per hop. Upload caps exist. Residual: DNS-rebinding race (acknowledged in a code comment). | Low | — |
| S-11 | Public-repo exposure | VERIFIED-FAIL (minor) | The public repo contains the full RUNBOOK and audit docs describing live weaknesses (report-only CSP, the MCP flag). `scripts/smoke-meeting-prep.ts:208-248` holds a real-looking third-party email and LinkedIn handle. | Low-Med | 1 h |
| S-12 | Model output / PII in logs | UNKNOWN | AI audit P0-6, fixed only on unmerged `claude/gallant-ramanujan-hh5j0s`. | Med | in R-03 |

### O. Reliability and operations

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| O-01 | Scheduled jobs run on time | VERIFIED-FAIL | The ops sweep plus the email, webhook and connector drains ran **7 times in about 24 h** (Oct 16 08:59 → Oct 17 05:42; gaps 2h13m–4h55m) against 144 expected. Radar nightly ran 4h44m late; Deepgram reconciliation 4h24m late (runs #1076–1121, `scratchpad/sched.tsv`). Fix: #457 (QStash), not merged and not provisioned. | High | 0.5 d + QStash |
| O-02 | Alerts reach a human, tested with a synthetic failure | VERIFIED-FAIL (never tested) | Slack critical webhook secret is present in `orbit` (job 117318387930: masked, non-empty). Test buttons exist (`actions/admin.ts:889-909`). No evidence any alert, page or Sentry notification was ever triggered end to end. **The alerting path was dead Oct 3–13**: runs #699–~#989 failed "Missing repository secret(s): APP_URL CRON_SECRET" (job 114460306726), then two 401s (job 115584012035). It went unfixed for 10 days. | **Blocker (a)** | 30 min |
| O-03 | Uptime and scheduler heartbeat | UNKNOWN (likely paused) | #457 step 4 says to "Unpause" the Better Stack heartbeat. Per #457 it was up 17% of 3 days (12 false incidents) because of O-01. | High | 5 min after #457 |
| O-04 | Error tracking | CLAIMED | Sentry is wired (`sentry.server.config.ts`, `instrumentation.ts:21`) and inert without `SENTRY_DSN`. Whether the DSN is set and whether an alert rule notifies anyone are UNKNOWN. | Med | 15 min |
| O-05 | Health checks | VERIFIED | `/api/health` 200 with schema and db ok in ops logs. The deep check needs `HEALTH_TOKEN`. | — | — |
| O-06 | Rollback procedure correct and timed | VERIFIED-FAIL | See D-08. Never timed. | **Blocker (a)** (doc) | 1 h |
| O-07 | Runbooks | Partial | Present: restore (never drilled), refund and chargeback (wrong order, B-04), AI outage, Deepgram kill switch, Resend rejected, bad deploy (wrong premise), partial secret rotation. **Missing:** Clerk/auth outage; rotation of the Stripe secret key, Neon password, Clerk secret, managed AI keys and age key; owner unavailable; status/incident comms. | High | 0.5 d |
| O-08 | Owner unavailable | VERIFIED-FAIL (none) | No doc and no second person. Every console (Vercel, Neon, Stripe, Clerk, Google) is single-owner as far as the repo shows. | High (b+) | 1 h |

### P. Product and quality

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| P-01 | Local gate passes | VERIFIED | Node 24.22 / npm 11.19:<br>• typecheck: 0 errors<br>• lint: 0 errors, 49 warnings<br>• `test:check`: 543 scripts<br>• build: pass (3m00s)<br>• e2e: 10 passed, 2 skipped (Stripe checkout needs test keys)<br>• extension: ci, typecheck, build and lint pass<br>• smoke: **526/541**. All 15 failures run through `net-guard.ts:118` `dns.lookup` (no DNS in this sandbox), time out, or are flaky under load (`constellation-match` passed on re-run). The same SHA passed the full suite in CI run 38983538008.<br>Under Node 22, `npm ci` fails on lockfile sync: use the pinned Node 24. | — | — |
| P-02 | End-to-end acceptance run | VERIFIED-FAIL (not done) | Changelog: "The roadmap's 14-step acceptance run … **has not been done**". No later evidence. E2e coverage: onboarding, capture, profile logging, tour and delete-data pass. **Not covered:** sign-up, BYOK setup, import, sync, chat, checkout, refund, cancel, auth-account deletion, export, Google consent, mobile. | **Blocker (b)**; partial for (a) | 1 d with stubs + real providers |
| P-03 | Free-limit behaviour | VERIFIED (local) | smoke-plan-enforcement and smoke-entitlements pass. But H-01 lets a client bypass it (S-01). | — | — |
| P-04 | Plan changes, lapsed, Lifetime-on-Pro | see B-07, B-13, B-15 | | | |
| P-05 | Data integrity on import and capture | VERIFIED-FAIL | H-04 and H-05 (S-01). #460's known-bug tier also lists, unfixed: contact merge drops opportunities (High), and a revoked Gmail token read as "no messages" (High). | High | in S-01 |
| P-06 | Empty, error and offline states | CLAIMED | The Sep 15 audit exercised empty and onboarding states in demo mode. The Oct 8 e2e audit lists polish bugs. Offline behaviour was not exercised. | Low | — |
| P-07 | Accessibility basics and mobile | VERIFIED-FAIL (no coverage) | No axe or jsx-a11y. `smoke-tier-contrast` and `smoke-tap-targets` exist and pass in CI. There is no mobile Playwright project. Changelog items 26–27 (VoiceOver, real phone taps) are not done. | Med | 0.5 d |
| P-08 | Capacity at ~1,000 users, heavy accounts | VERIFIED-FAIL (no test) | No load test exists (no k6, artillery or autocannon). Single-account bench `scripts/dev/dashboard-scale.ts`: 10k contacts = 15 statements, 1.98 MB payload (over the 1.5 MB ceiling asserted at 3k), 1.5 s median. Efficiency audit 2026-10-13: 25k-contact dashboard TTFB 774 ms; graph 1,038 ms with a 13 MB RSC payload, marked ❌. Tens of thousands of contacts is not covered by any automated run. | **Blocker (c)** | 1–2 d |

### A. Measurement and feedback

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| A-01 | Analytics exclude test, admin and comped accounts | VERIFIED-FAIL (partial) | `analytics-internal.ts:24-31` excludes only `ADMIN_USER_IDS` and the showcase account. Comped and test accounts are counted in traffic and the funnel. `buildPlanBreakdown` `paidTotal = comped + lifetime + subscribed` (`admin-metrics.ts:430-439`). | Med | 2 h |
| A-02 | Feedback widget works | CLAIMED | `components/feedback/*` → `submitFeedback` (`actions/feedback.ts:32`) → DB, Slack DM, `/admin/feedback`. Screenshots are Blob `access:"public"` behind a random suffix, proxied owner-or-admin. Not exercised. | Med | 10 min |
| A-03 | Criteria for advancing waves | VERIFIED-FAIL (none in repo) | Proposed in LAUNCH_PLAN §1. | Med | — |

### U. Support and communication

| ID | Gate | Status | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| U-01 | A working support channel | UNKNOWN | No published support address. `/contact` → Resend → `CONTACT_INBOX_EMAIL` (`contact-message-submit.ts:33-35`), plus GitHub issues on the public repo. Never shown to deliver. | **Blocker (a)** | 15 min |
| U-02 | Status page / incident plan | VERIFIED-FAIL (none) | No link anywhere, no template. | **Blocker (c)** | 2 h |
| U-03 | Known-issues list | VERIFIED-FAIL (none published) | #460 has 14 known bugs in-repo only. | Med | 1 h |
| U-04 | Invitation and welcome emails accurate | VERIFIED-FAIL (minor) | Invite "Now boarding: your Orbit pass" (`site-invite-email.ts:106`): playful, and its founding-pricing promise is backed. Waitlist emails promise an unimplemented badge and "priority beta" (C-06). Credit-notice emails assume included AI is running (C-02). | Med | 1 h |
| U-05 | Terms link discoverable | VERIFIED-FAIL | The marketing footer has no Terms link (`marketing-footer.tsx:6-11`). It is only reachable through the doc switcher. | Low | 5 min |

---

## 3. Failure rehearsal

Walked through against code, run history and runbooks. Nothing here was triggered in production. Recovery times are estimates from the evidence, not measurements, except where marked.

| Scenario | Detect | Mitigate | Recovery time | Gaps |
|---|---|---|---|---|
| **Bad deploy on launch day** | **Partly.** A failed build or migration never goes live (`check:env && db:migrate`). A bad *runtime* deploy: Sentry (DSN unknown), the Better Stack uptime probe on `/api/health`, and `errors.burst` in the sweep, which today runs every 2–5 h. | Promote the previous Vercel deployment. | About 5 min if you are at a keyboard and the target is v170 or later. Never timed. | Rollback across destructive DDL breaks export and purge (D-08). With the sweep lagging, a logic bug that isn't a 5xx can go unnoticed for hours. |
| **Stripe webhook outage** (endpoint down or secret rolled) | **Yes, slowly.** `webhook.invalid_streak:stripe` (sweep-cadence) and the admin provider panel's `pending_webhooks`. | Stripe retries for about 3 days. The handler returns 500 on failure so retries happen. Dedupe and ordering are verified (B-02, B-03). | Self-heals within 3 days once fixed. | Nothing reconciles events missed after Stripe stops retrying. `scripts/backfill-billing-events.ts` is manual. |
| **Database restore request** | n/a (operator-initiated) | Neon PITR to a new branch within the window (window UNKNOWN, assumed 6 h). Otherwise the last nightly dump (RPO up to about 28 h given the 4 h schedule lag). | **Unknown: never drilled.** Estimate 1–2 h for a small database plus verification. | No drill (D-03), no recorded key test, PITR window unverified (D-05). |
| **Leaked credential** | **Partly.** Rolled webhook secrets are caught by `invalid_streak`. A leaked Stripe key, Neon password, managed AI key or Clerk secret has no detector beyond provider dashboards and AI pool spend alerts (`ai.managed_spend_spike`). | Rotate per RUNBOOK:207-213, which covers only CRON, the webhook secrets and ENCRYPTION_SECRET. | 15–60 min per key once you know. | No runbook for most keys. `ENCRYPTION_SECRET` rotation is unsupported (no key versioning). Dependabot alerts and secret scanning are off or unknown. |
| **Auth vendor outage (Clerk)** | Sentry or uptime, if the health probe touches Clerk. Not specifically detected. | None. Signed-in pages and APIs fail. | Equal to Clerk's outage. | No runbook, no status-page message. |
| **AI provider outage** | **Yes:** `ai.provider_outage:*`, `ai.managed_failing:*`. | Automatic failover Anthropic → OpenAI → Gemini (`MANAGED_PROVIDER_ORDER`). Kill switch `ORBIT_MANAGED_AI=off`. Own-key users depend on their provider. | Automatic, seconds. | Works only if included AI is on (C-02) and every provider's key and pool is funded. |
| **Speech-to-text outage (Deepgram)** | Indirect (Sentry, user reports). The daily reconciliation detects billing gaps, not outages. | `ORBIT_DEEPGRAM=off` falls back to Whisper/Gemini on the user's own key (needs a redeploy). | About 5 min plus a deploy. | Users without their own OpenAI/Gemini key lose transcription. |
| **Email outage (Resend)** | `resend.rejected` (sweep-cadence). | The outbox retries via the email drain, which runs every 2–5 h today. | Hours. | Invitations sent during an outage are late. No user-visible notice. |
| **Spike from a viral post** | Stealth mode and the waitlist absorb signed-out traffic. Fail-closed rate limits. BotID on the waitlist and `/api/track`. | Clerk Restricted mode keeps strangers out. Waitlist writes are rate-limited per IP. | n/a | Every rate-limit check is a DB write. Neon free-tier compute limits and Vercel Hobby function limits are UNKNOWN. No load test (P-08). Once sign-up is public, the 100-user Google cap is the first wall (I-04). |
| **User demands deletion within 24 h** | n/a | Settings → Delete runs `purgeUserData` at once (`actions/settings.ts:480`). Clerk `user.deleted` does the same. A stranded purge resumes in process-stalled and alerts `purge.stuck`. | Minutes. Verified to leave zero rows locally (D-09). | Process-stalled runs every 3–5 h, not hourly. Backups retain the data for 90 days (disclosed). Deleting the Clerk account itself was not e2e-tested. |
| **Chargeback** | Not alerted. `charge.dispute.created` only books a ledger row. | A lost dispute revokes access automatically (verified, B-09). | Automatic on close. | No alert when a dispute opens, so evidence deadlines can be missed unless Stripe email notifications are on (B-01). |

---

## 4. What I verified myself (beyond the sub-agents)

- **Backups:** `orbit-ops` backup run list and artifact sizes and digests for all four runs. Public-repo backup runs 29–33 all failed.
- **Scheduler:** the 7 ops-sweep executions in `sched.tsv`.
- **Rollback:** the destructive DDL lines in `src/db/index.ts`.
- **Refund bug (B-04):** re-ran the refund-then-cancel probe; output quoted in B-04.
- **Paywall bypass (H-01):** read the code on `main`.
- **Schema collision:** `SCHEMA_VERSION = 171` on both branches.
- **Stranded code:** the three #453 files are missing on `main`.
- **Copy and flags:** `managedAiPausedDefault` and the landing Gmail copy; `oauthGrantFor` and the `CSP_ENFORCE` default.
- **Pause sales:** `isCheckoutConfigured` and the `sk_live_` requirement.
- **Analytics:** internal-account exclusion and `paidTotal`.
- **CI:** run 38983538008 on `bf1b4ae`.
- **E2e and smoke:** shard totals from the logs.

**Caveat:** for part of the session, one sub-agent's Node 22 `npm install` overwrote `node_modules` while others ran smokes. Every result above was either re-run on a clean Node 24 `npm ci` or corroborated by the green CI run on the same SHA.

---

## 5. Could not verify: what you need to do

Each one is UNKNOWN until you report the result. Read-only checks unless stated.

**Data**
1. **Restore drill (D-03):** `orbit-ops` → Actions → newest `backup` run → download the artifact. Then:
   - `age -d -i <key> orbit-*.pgc.age > orbit.pgc`
   - Create a Neon branch.
   - `pg_restore --no-owner --no-privileges -d "$BRANCH_URL" orbit.pgc`
   - Run the three counts from RUNBOOK:247 on both the branch and production.
   - Log the result and timings, then delete the branch.
2. **Neon (D-05, D-06):** Project → Settings → history retention (the PITR window). Branches → `main` → protected? Deletion protection on? Billing plan. Deep health: `config.statementTimeout = "20s"`?
3. **orbit-ops secrets (D-04):** is `SLACK_OPS_CRITICAL_WEBHOOK_URL` set? Is `DATABASE_URL` a read-only role?

**Hosting and vendors**
4. **Vercel (H-01):** Settings → Billing: plan name. Environment Variables, names only: `CSP_ENFORCE`, `MCP_OAUTH_REQUIRE_SCOPES`, `SENTRY_DSN`, `SLACK_OPS_WEBHOOK_URL`, `BETTERSTACK_HEARTBEAT_URL`, `RESEND_FROM_EMAIL` (which domain), `CONTACT_INBOX_EMAIL`, `SITE_STEALTH`, `ORBIT_MANAGED_GEMINI_API_KEY`, `NEXT_PUBLIC_EXTENSION_URL`.
5. **Better Stack (O-03):** is the scheduler heartbeat paused? Is the uptime monitor active, and which alert channel does it use?
6. **Sentry (O-04):** is there an alert rule, and where does it notify?

**Stripe live mode (B-01, B-05..B-08, B-10, B-15)**
7. The webhook endpoint's events and API version.
8. Whether the portal config `orbit_config=pricing_v2` exists, and what the default portal config is.
9. Public details: business name, support email, statement descriptor.
10. Receipts turned on.
11. Revenue recovery: the final action when all retries fail.
12. Dispute notifications.
13. Tax registrations.
14. **In test mode,** partially refund a charge and check whether `charge.refunded` contains `data.object.refunds.data`.

**Identity and platform**
15. **Clerk (I-01, I-03, I-09, S-02):** sign-up mode. Webhook events. Legal → express consent. Whether OAuth app scopes `orbit:read`/`orbit:write` exist. Whether dynamic client registration is on.
16. **Orbit admin (C-02, R-07, I-02, O-02):**
    - `/admin/billing`: is included AI on or paused?
    - `/admin/product`: the `app_surface_flags` overrides.
    - Site access: is `stealth_since` set?
    - `/admin/health`: press "Send test alert" and "Send test DM", and record whether they arrived.
17. **Google Cloud Console (I-04):** OAuth consent screen publishing status (Testing / In production); Verification Center status; scopes listed on the consent screen; test users.
18. **Microsoft Entra (I-07):** publisher verification and supported account types.

**Email, support and repo**
19. **DNS (E-01):** `dig +short TXT myorbitnetwork.com`, `dig +short TXT _dmarc.myorbitnetwork.com`, `dig +short TXT resend._domainkey.<sending domain>`. Also: the Resend dashboard domain shows "Verified", and the Resend plan's daily cap.
20. **Support (U-01):** send a `/contact` message in production and confirm it lands in `CONTACT_INBOX_EMAIL`.
21. **GitHub (R-05, S-08):** Settings → Branches (required checks). Code security → Dependabot alerts and secret scanning.

**Acceptance and capacity (P-02, P-08)**
22. On a preview with its own Neon branch and Clerk and Stripe in test mode, run the 14-step acceptance run (LAUNCH_PLAN §2.6 for the money steps, plus sign-up, BYOK, import, sync, chat, export, Google consent and phones).
23. Run the load test in LAUNCH_PLAN §3.3 against that preview, never production.
