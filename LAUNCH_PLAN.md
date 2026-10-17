# Orbit launch plan

**Date:** 2026-10-17 · **Reviewed commit:** `bf1b4ae` (origin/main, deployed to Production 2026-10-16 23:53 UTC per the GitHub Deployments API) · **Companion:** [`LAUNCH_READINESS.md`](LAUNCH_READINESS.md) has the evidence, status and verdict for every item named here.

This is the critical path, in order. Each step names the smallest piece of work that closes the gate. Nothing in this file has been done. It is a plan, not a record.

Effort is one focused person. "Dashboard" means a console change with no code.

---

## 0. Merge and freeze (do this first, about 1 day)

`main` is green and deployed, but three pieces of work that the launch needs are not on it. Three things decide the plan:

- **338 branches** are not merged.
- **49 PRs** are open.
- **Two branches claim schema version 171.**

### 0.1 Merge into the release candidate, in this order

| # | What | Why now | Watch for |
|---|---|---|---|
| 1 | Open a PR for `claude/trusting-wozniak-ebsks3` (security Phase 1: H-01..H-05, M-06, M-17). Run full CI. Merge. | H-01 is a live paywall bypass on `main`. H-03 lets one calendar line hang the shared sync worker. H-04/H-05 lose or duplicate user data. Only the Vercel preview has run on this branch. | It sets `SCHEMA_VERSION = 171`. |
| 2 | Decide `claude/gallant-ramanujan-hh5j0s` (AI audit P0s, including P0-6: model output written to logs). Merge it if CI is green. | Personal data in logs. | |
| 3 | Rebase and merge **#325** (pins for the Actions group). | GitHub moves runners to Node 24 now and `ubuntu-latest` to Ubuntu 26 on **Oct 19**. | Touches `ci.yml` and `ops.yml`. Merge it before #457. |
| 4 | Do #457's setup steps (QStash on Pay-as-you-go, run `scripts/qstash-schedules.ts` with the production `CRON_SECRET`). Then merge **#457**. | GitHub fires about 12% of scheduled runs. The 10-minute sweep, the email outbox, the webhook drain and the connector outbox actually run every 2–5 hours. | Add QStash (Upstash) to the privacy page's processor list in the same change. |
| 5 | Merge **#460** (risk-ranked tests, known-bug tier, security job, `post-deploy.yml`). Rebase first; it is 1 commit behind. | Turns this review's gates into CI. It also records 14 known, unfixed bugs. Two are High: a contact merge drops opportunities, and a revoked Gmail token reads as "no messages". | No app code. Conflicts only with the unmerged `youthful-johnson` and `wonderful-thompson` branches. |

### 0.2 Hold back, renumber or close

- **`claude/serene-cerf-0is3sb`** (performance indexes) also writes `SCHEMA_VERSION = 171`. If it goes in after step 1, renumber it to **172**. Otherwise production is stamped 171 by the first one and never runs the second one's DDL. If not needed for launch, hold it until after the freeze.
- **Defer** these stacks until after launch:
  - Email insights: #386→#399, schema **v145**
  - Leads: #264→#343, **v121–v124**
  - Constellation: #372→#405
  - Extension: #246→#254
  - Account page: #265/#276
  - Major dependency bumps: #330 TypeScript 7, #334 ESLint 10, #331 motion 14, #333 @types/node 26
  - #433, which fails smoke
  
  The Leads and email-insights stacks claim versions *below* production's 170. Merged as written, they are silently skipped forever. Each needs a fresh number above `main` before it is revived.
- **Close:** #6, #8, #9, #60, #70, #85, #97, #117, #183, #186, #239, #352. All are 650–1,400 commits behind; #117, #183 and #186 carry schema v24/v56.
- **Decide on the stranded code:** #453 merged into `claude/linkedin-export-store` 49 minutes *after* that branch merged to `main`. About 770 lines never reached `main`: `linkedin-export-extras.ts`, `linkedin-signals.ts`, `linkedin-export-apply.ts` and two smokes. Revive it after the freeze, or say it is dropped.

### 0.3 Freeze

1. Tag the result `rc-1` and record its SHA at the top of `LAUNCH_READINESS.md`.
2. Re-run the local gate on that SHA: `typecheck`, `lint`, `test`, `build`, `test:e2e`.
3. Deploy. Confirm `/api/health` → `sha` equals `rc-1` and `deploy.drift` is clear.
4. From then until wave 1 has run for 7 days, `main` takes only fixes for this plan or for a bug a user hit. Each fix needs full CI and a post-deploy health check.
5. Turn on branch protection for `main`: required checks `check` and `smoke` (the CI comment says they are not required today). Drop `paths-ignore` when you do, so docs-only PRs aren't blocked forever.
6. **No `DROP` / `RENAME` DDL during the freeze.** Rollback depends on it (see §5).

---

## 1. Before the first external user (wave 1: ~10–25 invited people)

Minimum work, in order. About 2–3 days, most of it console work.

| # | Work | Effort | Closes |
|---|---|---|---|
| 1.1 | Steps 0.1–0.3 above | 1 d | Security H-01..H-05, scheduler, RC identity |
| 1.2 | **Restore drill.** Download the newest `orbit-ops` backup artifact. Decrypt it with the age key from the password manager (this also proves the key exists). Restore into a throwaway Neon branch. Compare contacts / interactions / accounts with production. Log it in `docs/RUNBOOK.md`. Time each step. | 2 h | No restore has ever run. The Oct 13/14 artifacts are both exactly 248,571 bytes and the Oct 15/16 ones both exactly 416,523 bytes. Their digests differ, as encryption would make them, but identical sizes a day apart on a database the ops jobs write to every few hours is unexpected. Only a restore proves what the dumps contain. |
| 1.3 | **Pin the backup runner.** In `orbit-ops/backup.yml`, change `runs-on: ubuntu-latest` → `ubuntu-24.04` before **Oct 19**. Then **Run workflow** once by hand. | 10 min | The PGDG install may not support Ubuntu 26 on day one. The backup would then fail every night. |
| 1.4 | **Backup heartbeat.** Create the Better Stack heartbeat "orbit backup" (1 day period, 12 h grace). Set `BETTERSTACK_BACKUP_HEARTBEAT_URL` in `orbit-ops`. Confirm `SLACK_OPS_CRITICAL_WEBHOOK_URL` is set there too. | 15 min | The log shows the heartbeat is unset ("not set, skipping"), so `backup.stale` doesn't exist even though the runbook relies on it. |
| 1.5 | **Fire a test alert end to end.** `/admin/health` → "Send test alert" and "Send test DM". Confirm both arrive in Slack on a phone with notifications on. Then pause the Better Stack uptime monitor's target for one probe, or point a second monitor at a 404 URL, and confirm the page reaches you. Write down the times. | 30 min | No alert has ever been shown to reach a human. |
| 1.6 | **Unpause the Better Stack scheduler heartbeat** once #457 is live. #457 step 4 implies it is paused now. | 5 min | A dead scheduler is invisible. |
| 1.7 | **Clerk:** sign-up mode = **Restricted**. Confirm the webhook subscribes to `user.created`, `user.updated`, `user.deleted`. Turn on Legal → "Require express consent". In `/admin` → Site access, save stealth **On** once so `stealth_since` is set. | 20 min | With only `SITE_STEALTH=1`, an uninvited Google sign-in is not held. |
| 1.8 | **Google:** if the consent screen is in Testing, add every wave-1 email under Audience → Test users. In-app, keep `page.events`, `feature.cloud-notes` and `feature.compose` coming-soon, and hide `page.recruiters` unless every invitee is a listed test user. | 30 min | Restricted Gmail/Drive scopes otherwise show a Google block page. The app reports it as "connection cancelled". |
| 1.9 | **Included AI.** `/admin/billing` → read whether included AI is on. It defaults to **paused** on production. If it stays paused, wave 1's invite and welcome copy must not say "AI included" (the pricing page does). Before switching it on, confirm in each provider console that no-training / zero-retention applies to Orbit's org: Anthropic, OpenAI, and **Gemini, which is in the managed order but not on the privacy page**. | 1 h | The paused default contradicts the copy. |
| 1.10 | **MCP:** define `orbit:read` / `orbit:write` scopes in Clerk's OAuth app, set `MCP_OAUTH_REQUIRE_SCOPES=1`, redeploy. If you aren't inviting anyone to use the MCP connector, the flag alone is enough. | 1 h | Any OAuth client that asks only `openid email` gets full CRM write today. |
| 1.11 | **Neon:** read History retention (PITR). Mark `main` protected. Enable deletion protection. Confirm `statement_timeout` = 20s via the deep health check. Write the window into the runbook. | 15 min | The PITR window is assumed to be 6 h and has never been checked. |
| 1.12 | **Runbook fixes (docs only):** (a) "Roll back" must say promoting a build older than v170 is unsafe (see §5). (b) "Refund or chargeback" must say **cancel the subscription first, then refund**. Refunding first, then cancelling, re-grants Pro until the period ends (reproduced, see readiness B-04). (c) Add a "Clerk is down" and an "I'm unavailable" section. | 1 h | |
| 1.13 | **Known-issues list for invitees:** the 14 known bugs from #460, the calendar-feed link shown once, Google's 7-day token expiry in Testing mode (reconnect prompts), Radar/Events/Outreach coming soon. | 1 h | |
| 1.14 | **Support channel:** decide where wave 1 reaches you (a monitored address on the domain, or the /contact form → `CONTACT_INBOX_EMAIL`). Send yourself a /contact message in production and confirm it arrives. | 15 min | No support address is published. Nobody has shown the contact form delivering. |

**Exit criteria for wave 1 → wave 2** (measured on `/admin/analytics`, which excludes admins and the showcase account, *not* comped accounts, so filter those by hand):

- 7 days with no Sev-1: no data loss, no cross-tenant read, no user locked out longer than 1 h.
- Ops sweep and drains running on schedule for all 7 days (`cron_runs`). Zero `backup.stale`.
- At least 60% of invitees complete onboarding and capture or import at least 10 contacts. At least 40% return in week 1.
- No open Sev-2 feedback older than 72 h in `/admin/feedback`.
- Sentry error rate flat or falling. No unexplained `errors.burst`.

---

## 2. Before anyone pays

Payments are live in code. Production builds require an `sk_live_` key, and stealth mode is what keeps strangers off checkout today. There is no "pause sales" switch: unsetting `STRIPE_SECRET_KEY` would also break cancel and the billing portal. Until this section is done, don't send checkout links, and treat any purchase by an invitee as something to watch by hand. About 3–5 days plus waiting on outside parties.

| # | Work | Effort | Closes |
|---|---|---|---|
| 2.1 | **Vercel Pro.** Hobby is non-commercial. All evidence says the team is on Hobby (Vercel API in the Sep 15 audit; `ops.yml:3`). | 10 min + $ | Hosting terms |
| 2.2 | **Fix refund-then-cancel (B-04).** `subscription_revoked` must move `subscription_event_at` forward, or a `deleted` after a refund revoke must keep the revoke. Add a smoke for that exact order. Until then, follow the corrected runbook order. | 2 h | Refunded customers keep Pro |
| 2.3 | **Refund ledger (B-05).** In test mode, issue a partial refund and open the `charge.refunded` payload. If `data.object.refunds.data` is missing (current API versions omit it), book refunds from `refund.created` or `refunds.list({charge})`. | 2–4 h | Net revenue overstated |
| 2.4 | **Stripe live dashboard:** (a) webhook endpoint subscribes to the 10 handled events (list in readiness B-01). (b) Portal config "Orbit (pricing v2)" exists with `orbit_config=pricing_v2`, and the *default* portal config is safe too, because the code falls back to it silently. (c) Business public name "Orbit", support email, statement descriptor. (d) Receipts for successful payments and refunds turned on. (e) Revenue recovery → "if all retries fail" = **mark unpaid**, not cancel; cancel keeps access until the period ends. (f) Dispute notifications on. | 1 h | B-01, B-06..B-09 |
| 2.5 | **Tax decision.** No `automatic_tax` anywhere. Decide with an accountant whether you must collect; if so, enable Stripe Tax and add `automatic_tax` + address collection to checkout. | 0.5 d + adviser | B-10 |
| 2.6 | **Test-mode acceptance run of money.** On a preview with test keys: buy Pro monthly → upgrade to Max in the portal → cancel at period end → resume → full refund (cancel first) → buy again → dispute with the `4000000000000259` test card and close it lost → confirm access drops each time and `billing_events` matches the Stripe balance. Also run `smoke-stripe-testclock`. Record timings. | 0.5 d | B-02..B-07 |
| 2.7 | **Comped subscribers (B-12).** Comping a paying Pro/Max user doesn't cancel their subscription and hides the portal from them. Cancel it at period end when comping, or don't comp paying users. | 1 h | Billed with no way out |
| 2.8 | **Legal review** of `/privacy` and `/terms` by a lawyer (no evidence of any so far). Before sending them over, fix what's known to be wrong: name a governing jurisdiction and a postal address; add Gemini to the managed-AI processors; correct the Resend, Twilio, Slack and Microsoft descriptions; add a data-subject-rights section. Bump `TERMS_VERSION` after changes. Re-acceptance is a banner, not a gate; decide with the lawyer whether that is enough. | 1–2 wks elapsed | C-07..C-10 |
| 2.9 | **Copy:** remove or qualify every mismatch in readiness §C-01: "AI included" while paused, Gmail promises to Free users, "Unlocks with Orbit Pro" on Radar/Find, Lifetime "permanently", waitlist "founding member badge" / "priority beta". | 0.5 d | |

---

## 3. Before public sign-up

| # | Work | Effort |
|---|---|---|
| 3.1 | **Google verification.** The default Connect asks for `contacts.readonly` + `calendar.readonly`, which are sensitive scopes. An unverified app shows the "Google hasn't verified this app" screen and is capped at 100 users for the lifetime of the project. Submit brand and sensitive-scope verification now; it takes weeks. Keep `gmail.readonly`, `gmail.send` and `drive.readonly` (restricted, need CASA) **out** of the consent screen and the app until CASA is done. That needs a code change: gate "Send from Gmail" and `startGmailOAuth` purposes `send` / `recruiter_scan` / `event_mail` / `drive_scan` behind a server-enforced surface flag. Also make "blocked by Google" read differently from "cancelled". | 1 d code + weeks waiting |
| 3.2 | **Microsoft publisher verification** (MPN ID) and confirm the `common` tenant is intended. | 1 h + waiting |
| 3.3 | **Load test.** Nothing in the repo tests ~1,000 users or tens of thousands of contacts per account. Seed a Neon branch (not production) with 1,000 accounts, 5 of them at 30k–50k contacts. Run k6 or Artillery against a preview for the dashboard, contact search, chat, import of a 20k-row CSV, and the sync run. Targets: p95 page under 1.5 s, chat first token under 4 s, import of 20k rows under 10 min, zero 5xx, Neon CPU under 70%. Record it in `docs/performance.md`. | 1–2 d |
| 3.4 | **CSP enforce.** Read a week of `csp.report` rows, then build with `CSP_ENFORCE=1`. | 1 h + a week |
| 3.5 | **Least-privilege DB role.** A runtime role without DDL for `DATABASE_URL`, and a migration role used only by `db:migrate` at build. A read-only role for `orbit-ops` backups. | 0.5–1 d |
| 3.6 | **Email compliance.** Postal address in every bulk/marketing template (CAN-SPAM). Verify SPF/DKIM/DMARC with `dig TXT myorbitnetwork.com`, `dig TXT _dmarc.myorbitnetwork.com`, `dig TXT resend._domainkey.<sending domain>` (couldn't be checked from this sandbox). DMARC at least `p=quarantine`. Know your Resend plan's daily cap; the free tier is 100/day. | 2 h |
| 3.7 | **Status and incident comms.** A status page (Better Stack status page is free), linked from the app footer and the contact page. A two-line incident template. A Terms link in the marketing footer (only reachable via the doc switcher now). | 2 h |
| 3.8 | **Bus factor.** A sealed "if I'm unavailable" note in the password manager, shared with one trusted person: how to pause sign-ups (Clerk → Restricted), pause included AI (`/admin/billing`), turn on `ORBIT_MANAGED_AI=off`, and post on the status page. | 1 h |
| 3.9 | **Turn on Dependabot alerts and secret scanning** on the public repo (both off or unknown). Move the audit docs that describe live weaknesses out of the public repo (the `docs/*audit*` files). Scrub the real-looking third-party email in `scripts/smoke-meeting-prep.ts`. | 1 h |
| 3.10 | **Analytics:** exclude comped and test accounts from the funnel and `paidTotal` (only admins and the showcase account are excluded today, and `paidTotal` adds comps in). | 2 h |
| 3.11 | **Then open:** Clerk sign-up mode → Public, *and* `/admin` → Site access → stealth Off. There is no single switch; it takes both. | 5 min |

---

## 4. Merge-and-freeze summary

```
main (bf1b4ae, deployed)
  + trusting-wozniak (security H-01..H-05)  → v171
  + gallant-ramanujan (AI P0s)              → if green
  + #325 action pins
  + #457 QStash scheduler                   → after QStash provisioned
  + #460 tests / CI hardening
  = rc-1  → full local gate → deploy → health sha == rc-1 → FREEZE
  (serene-cerf only after rc-1, as v172)
```

---

## 5. Rollback plan

**The runbook's rollback is not safe as written.** It says schema changes are additive and old code runs on a newer schema. `src/db/index.ts` has destructive DDL:

- `DROP TABLE IF EXISTS guest_profiles` (:4714, v170)
- `DROP COLUMN` at :2734, :2841, :2875, :4604, :4720
- `RENAME` at :3496, :4774

A build from before v170 still references `guest_profiles` in export, purge and guest look-up. Old code never re-runs its DDL, so the table doesn't come back.

**Rules from `rc-1` on:**

1. **Safe rollback window** = any deployment at schema v170 or later (i.e. `124388f` and newer). Before launch, write down the oldest safe deployment URL in the runbook. Don't promote anything older.
2. **Code-only bad deploy (most likely):** Vercel → Deployments → previous `rc-*` → Promote. Target under 5 minutes. **Time it once on a preview before launch** (this has never been timed). Then check `/api/health` = 200 and the sha.
3. **Bad migration:** don't roll back code. Take a manual backup (`orbit-ops` → Run workflow), fix forward with a new schema version. If data was damaged: Neon point-in-time restore *to a new branch* within the PITR window, compare, then swap `DATABASE_URL`. If outside the window: restore last night's dump (§1.2 drill gives the timing).
4. **Calendar feeds:** don't promote a deployment from before the hashed-token change (Sep 17); every feed URL would 404.
5. **During the freeze, only additive DDL.** A rename or drop goes in a two-step release after launch.

---

## 6. Launch-day and first-week monitoring checklist

**Launch day (before the first invite goes out)**

- [ ] `/api/health` 200, `sha` = `rc-1`, `schema` 17x/17x, deep check `config.statementTimeout = "20s"`.
- [ ] `/admin/health` → no open critical alerts; Ops sweep tile fresh (<15 min with QStash).
- [ ] Better Stack: uptime monitor green, scheduler heartbeat **unpaused** and green, backup heartbeat green.
- [ ] Slack `#orbit-ops-critical` notifications on your phone; test alert received today.
- [ ] Sentry: alert rule for new issue → email/Slack, tested once.
- [ ] Last night's `orbit-ops` backup succeeded; artifact size not 0.
- [ ] Clerk mode Restricted; stealth On with `stealth_since` set; invite yourself on a second email and walk sign-up → onboarding → Google Connect → first capture on a phone.
- [ ] Included-AI state matches what the invite email says.

**Every day, first week (15 min, morning)**

- [ ] `/admin/health`: open alerts, error events, failed/stalled imports, webhook deliveries (Stripe/Clerk pending or failed), `purge.stuck`.
- [ ] `cron_runs`: every job ran within its interval in the last 24 h.
- [ ] Backup ran; Better Stack all green.
- [ ] Sentry: new issues triaged, each either fixed, ticketed or marked known.
- [ ] `/admin/feedback` and the contact inbox: every item answered within 24 h.
- [ ] `/admin/billing`: managed-AI pool burn vs runway; any `ai.managed_cap_hit`.
- [ ] Google OAuth errors (`calendar.disarmed`, reconnect prompts): 7-day token expiry in Testing mode will hit around day 7.
- [ ] Stripe: Payments, Disputes and Events (failed deliveries) if anyone paid.

**End of week 1:** score the exit criteria in §1. Move to wave 2 only if all are met.

---

## 7. Can safely wait until after launch

- Deferred PR stacks: Leads, email insights, constellation visuals, extension sp1–7, account page. Renumber the schema when you revive them.
- Major dependency bumps (TypeScript 7, ESLint 10, motion 14, @types/node 26) and the 49 lint warnings.
- npm audit highs/critical: all on the `@clerk/ui` → Solana wallet → react-native build chain or on build-only tools, none loaded at runtime. Take #433's `@clerk/ui` bump once it passes smoke.
- Encryption-key rotation support (`ENCRYPTION_SECRET` has no key versioning).
- Row-level security (isolation is enforced in code and covered by passing smokes across 474 actions).
- DNS-rebinding hardening of the SSRF guard.
- Chrome Web Store listing (the extension is hidden unless `NEXT_PUBLIC_EXTENSION_URL` is set).
- The ledger-vs-Stripe automatic reconciliation job (do it by hand weekly until volume justifies it).
- Svix-id dedupe on the Clerk webhook (handlers are idempotent; low risk).
- A Pro-gate for Radar/Find (fix the copy now instead).
