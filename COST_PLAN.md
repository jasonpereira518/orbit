# Orbit cost plan

Companion to `COST_AUDIT.md` (findings U1–U12, F0–F15) and `cost/unit-economics` (the model).
Date: 2026-10-17.

## Status (phase 2, 2026-10-17)

You approved the quick wins except Vercel Pro, and added two facts: a **$15,000 one-time
Deepgram credit** to fund allowances, and **Lifetime is admin-granted, so it is not modelled**.

| Item | Status |
|---|---|
| P1.1 dashboards: Neon plan, vendor spend alerts, Clerk bot protection | **Yours to do.** No code; this session cannot reach those dashboards. Vercel Pro is skipped, at your request. |
| P1.2 Deepgram in dollars | **Done.** `src/lib/speech-cost.ts` prices `speech_usage`. Money → Costs shows it. The Stripe estimate counts per charge plus Billing. |
| P1.3 Deepgram budget that degrades | **Done, as the $15k credit.** A pool with a 90 / 97 / 100% ladder (`DEEPGRAM_CREDIT`, `deepgramOpenFor` in `src/lib/speech-credit.ts`). |
| P1.7 Slack alerts + weekly line | **Done.** Alerts: `speech.credit`, `speech.credit_runway`, `speech.spend_spike`, `budget.month` (set `ORBIT_MONTHLY_BUDGET_CENTS`). Every Monday from 08:00 UTC: "Week N: $X estimated spend, $Y per active account". |
| P2.1 idle dictation sockets | **Done.** 15 s without words ends a Deepgram dictation session. |
| P2.2 keyterms | **Done as a switch** (`ORBIT_DEEPGRAM_KEYTERMS=off`), default on. Keyterms are contact names; measure before turning them off. |
| P2.3 meeting double billing | **Done.** The chunk is claimed before transcription. |
| D3 Free voice notes | **Decided: keep 60 min**, funded by the credit. |
| D4, D5 Lifetime | **Dropped.** Admin-granted, not modelled. |
| Everything else | Still waiting for your approval. |

The ordering follows your rules:
- Stop surprise bills first.
- Then take the simple, low-risk savings.
- Then the pricing decisions only you can make.
- Then a review rhythm.

Anything that trades reliability, data safety or privacy for money is marked **⚠️ trade-off**.

"Savings @1k / @10k" are monthly, from the model's default scenario (Deepgram at 2× list, included
AI paused). They inherit its guesses and are meant for ranking, not for budgeting.

---

## Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | Monthly budget for `budget.month` | Set `ORBIT_MONTHLY_BUDGET_CENTS=15000` ($150) in Vercel. The Deepgram budget is now the $15k credit itself. |
| D2 | What degrades first as the credit runs out | **Implemented as recommended:** Free voice notes at 90%, everyone's voice notes and the chat mic at 97%, new meetings at 100%. Meetings already recording always finish. The rungs are constants in `SPEECH_CREDIT_LADDER` if you want them elsewhere. |
| D3 | Free voice-note allowance | **Decided: 60 min**, funded by the credit. |
| D10 | When the credit gets low: top up, or tighten allowances? | Decide when `speech.credit_runway` fires (under 45 days left). At ~1,000 accounts that is ~20 months away; at ~10,000, ~2 months. |
| D6 | Resume included AI (coded on, paused)? | **Not yet.** Fix web-search metering (P2.6) first, then resume for Pro and Max only. Keep Free at 0–10 credits. |
| D7 | Deepgram privacy flag `mip_opt_out=true` (may double the rate) | **Keep it ⚠️.** Confirm the premium from the invoice, then negotiate (Growth plan or a zero-retention contract) rather than drop it. |
| D8 | Pro allowance 5 h + 5 h | Keep it for existing subscribers. For new ones, consider 4 h + 4 h, or one shared 8 h pool. |
| D9 | Repo visibility | If it will go private, move the schedules first (P2.8), or pay about $65–80 a month for Actions. |

---

## Phase 1: caps, kill switches and alerts (prevent a surprise bill)

### P1.1 Fix the platform plans and set vendor-side limits (no code)
- **Approach:**
  - **Vercel:** move to Pro, which Hobby's no-commercial-use rule requires. Then Settings → Spend
    Management: budget $100, alerts at 50/75/100%.
    - Do not enable auto-pause. ⚠️ Pausing is an outage. If you want a hard stop, set it high,
      e.g. $400.
  - **Neon:** check Billing. On Free, move to Launch (pay-as-you-go, no minimum), because Free
    suspends compute past 100 CU-hours and fails writes past 1 GB. Set the max autoscale to
    2 CU to bound compute. ⚠️ That slows heavy pages under load rather than failing them.
  - **OpenAI and Anthropic consoles:** set project or workspace spend limits equal to the pools
    in `managed-ai-policy.ts` ($190/month, $950), as a second layer behind the code.
  - **Deepgram console:** check whether the project supports usage limits or low-balance alerts
    ⚠️ (unconfirmed). If not, P1.3 is the limit.
  - **Clerk:** enable sign-up bot protection, block disposable email domains and require email
    verification, where your plan offers them ⚠️.
- **Files:** none (dashboards). Then update `cost/unit-economics/inputs.json` (`neon.plan`, `neon.minCu`).
- **Effort:** 1–2 hours.
- **Expected cost @1k / @10k:**
  - Spend rises by about +$20 (Vercel) and +$0–40 (Neon) a month.
  - This is the price of staying within the terms of service and avoiding outages.
- **Risk:** reduces risk.
- **Verification:**
  - Vercel and Neon billing pages show the new plans.
  - A test alert email arrives from Vercel.
  - Next month, the Neon invoice line matches `infra_costs` (`cost/reconcile`).

### P1.2 Put Deepgram in dollars everywhere — DONE (phase 2)
- **Approach:**
  - **Rate:** replace the $0.0043/min constant with an effective rate per kind: streaming,
    streaming + diarize, file. Take the value from the invoice; the reconciliation prints it.
  - **Spend rows:** write a `usage_events` row (`provider='deepgram'`, `key_owner='orbit'`) per
    file transcription and per closed meeting/dictation session. For live sessions, write it when
    `speech_usage` is finalised.
  - **Screens:** add the line to Money → Costs, to runway burn, and to "contribution per
    subscriber".
  - **Stripe estimate:** in the same change, fix the Stripe fee estimate to count every charge
    plus Billing's 0.7%.
- **Files:**
  - `src/lib/ai-pricing.ts:102-108`
  - `src/lib/ai.ts:953-974`
  - `src/lib/meeting-sessions.ts` (session close)
  - `src/app/api/speech/usage/route.ts`
  - `src/lib/managed-ai-ops.ts:26` (separate the Deepgram sum rather than excluding it)
  - `src/lib/money-costs.ts:131-139`
  - `src/app/(clerk)/(admin)/admin/billing/costs/page.tsx:59-66`
  - `src/lib/admin-yc-metrics.ts`
- **Effort:** 1 day.
- **Expected savings @1k / @10k:** $0 direct. It makes the biggest cost line visible.
- **Risk:** low (writes only, plus display).
- **Verification:**
  - Smoke test: a fake 60 s file transcription records a cost row at the configured rate.
  - The reconciliation's Deepgram line passes within 10% on the next invoice.

### P1.3 Global Deepgram budget that degrades instead of failing — DONE as the $15k credit (phase 2)
- **Approach:**
  - **Budget check:** the ops sweep (every 10 min) sums this month's Deepgram spend from P1.2
    against a budget, `DEEPGRAM_MONTHLY_BUDGET_CENTS` or a `site_settings` value (D1).
  - **A ladder, applied through a runtime switch** (`site_settings.speech_tier_paused`, the same
    pattern as `managed_ai_paused`, with a 30 s cache):

    | Share of budget | What happens |
    |---|---|
    | 50% | Slack info |
    | 75% | Warning |
    | 90% | Free accounts stop getting Deepgram |
    | 100% | Short-form (voice notes, dictation) stops on Orbit's key for everyone |
    | 120% | New meeting sessions stop on Orbit's key |

  - **Fallbacks, all of which already exist:**
    - voice notes fall back to the user's own OpenAI/Gemini key;
    - dictation falls back to the browser's own speech recognition;
    - meetings fall back to chunk recovery on the user's key, or a clear "add your key" message.
  - Sessions already open always finish.
  - An admin console toggle overrides the ladder.
- **Files:**
  - `src/lib/ops-alerts.ts` and `src/lib/ops-sweep.ts` (new `speech.budget` condition)
  - `src/lib/deepgram.ts:59-63` (`deepgramEnabled` → per-plan, per-kind check)
  - the token routes `src/app/api/speech/token/route.ts` and `src/app/api/capture/meetings/[id]/stream-token/route.ts`
  - a new `src/lib/speech-switch.ts` (copy `managed-ai-switch.ts`)
  - the admin health page
- **Effort:** 1–2 days.
- **Expected savings @1k / @10k:** bounds the worst case at the budget. At 10k, an unbounded
  abusive 2% of accounts would cost about $500–2,000/month (model, "abusive" profile).
- **Risk:** low.
  - ⚠️ At 90%+, Free users lose Orbit-paid voice notes until the 1st.
  - No data is lost, and in-flight sessions are untouched.
- **Verification:**
  - Smoke test with a fake spend total at 89%, 91% and 101%: the token routes answer per the ladder.
  - The fallback path is exercised with `ORBIT_DEEPGRAM=off` locally.

### P1.4 Bound live streams on the server side (U1, U4)
- **Approach:** a websocket proxy on Vercel is not worth it, so tighten what the server controls:
  - **Token minting:**
    - mint a grant only when remaining ≥ 60 s;
    - return `remainingSeconds` to dictation and make the client honour it;
    - refuse tokens for meetings already `ended`.
  - **Tagging:** require a tag on every grant, by rejecting a client request with no session id.
  - **Nightly per-account check:** if Deepgram's figure exceeds recorded usage by more than 1.5×,
    put that account's Deepgram on the fallback for the rest of the month and alert. That is a
    degrade, not a ban.
  - **Reconciliation:**
    - alert on untagged traffic (today it is skipped silently);
    - alert when the 50-page read limit is hit.
  - **File transcription:** refuse files longer than the remaining allowance plus 60 s, by
    checking the duration before calling Deepgram. Header-derived duration, or file size ÷ bitrate.
- **Files:**
  - `src/app/api/speech/token/route.ts:70-76`
  - `src/lib/use-dictation.ts:41,819-823`
  - `src/lib/meeting-sessions.ts:51`
  - `src/app/api/ops/speech-usage/route.ts:215-240,351`
  - `src/lib/deepgram.ts:24-26,165-207`
  - `src/lib/ai.ts:933-940`
  - `src/lib/capture-ingest.ts:38-40`
- **Effort:** 1–2 days.
- **Expected savings @1k / @10k:** prevents losses rather than cutting steady-state spend. It
  caps a tampered client at about one day of overrun.
- **Risk:** low–medium. An honest user on a flaky network could be over-reported, so the action
  is a fallback with an alert, never a suspension.
- **Verification:**
  - Smoke tests for each refusal.
  - Replay a fake Deepgram usage page with an untagged request and a 2× account: two alerts and
    one fallback.

### P1.5 Kill switches for every metered feature
- **Approach:** add env kill switches, each read once per request like `ORBIT_DEEPGRAM`:
  - `ORBIT_SYSTEM_EMAIL=off`, with a per-category allowlist so the contact form and security
    mail can stay on;
  - `ORBIT_SMS=off`;
  - `ORBIT_MICROLINK=off`.
  - Set `hostedSending: false` in `PLAN_CONFIG` until Outreach ships, so the demo-workspace
    bypass cannot send on Orbit's Resend or Twilio.
  - Make the 50/day outreach cap atomic: insert-then-count in one statement, or use a
    `rate_limit_buckets` bucket.
- **Files:**
  - `src/lib/plans/plan-config.ts:73-75,124`
  - `src/lib/outreach-send.ts:41-60,72-132`
  - `src/lib/interest-list-email.ts`, `src/lib/credits/notices.ts`, `src/lib/radar/digest.ts`
  - `src/lib/contact-avatar.ts:112-128`
  - `.env.example`
- **Effort:** half a day.
- **Expected savings @1k / @10k:** $0 steady state. Removes three unbounded paths (U6–U8).
- **Risk:** low.
- **Verification:**
  - Smoke test that each switch blocks its path.
  - A demo-workspace account can no longer resolve a hosted sender.

### P1.6 Cap Microlink and the waitlist mail (U7, U8)
- **Approach:**
  - **Microlink:** keep a global daily bucket even when the key is set, for example the paid
    plan's monthly requests ÷ 30, and alert at 80% of it.
  - **Waitlist:** add a global hourly cap on referral-tier emails. Lower the welcome cap to
    match the Resend plan's daily limit, and queue the rest for the next day instead of having
    them rejected.
- **Files:**
  - `src/lib/contact-avatar.ts:118-122`, `src/lib/rate-limit.ts:164-171,329`
  - `src/lib/ops-sweep.ts:176-182`
  - `src/lib/interest-list-join.ts:262-388`
- **Effort:** a few hours.
- **Expected savings @1k / @10k:** $0–150 and $0–300, only if the Microlink key is set.
- **Risk:** low. Some photos fill a day later.
- **Verification:** smoke test that the bucket refuses past the cap with the key set.

### P1.7 Budget alerts to Slack, and the weekly cost-per-active-user number — DONE (phase 2)
- **Approach:**
  - **Budget alert:** a new ops condition, `budget.month`. The ops sweep compares month-to-date
    estimated spend against D1's budget, at 50, 75, 90 and 100%.
    - The spend estimate is P1.2's Deepgram cost, plus Orbit-paid AI from `usage_events`, plus
      the last entered `infra_costs` prorated by day.
    - Alerts go to `SLACK_OPS_WEBHOOK_URL`; 100% also goes to `SLACK_OPS_CRITICAL_WEBHOOK_URL`.
  - **Weekly number:** on Monday's first sweep, post one line: *"Week N: est. $X spend, Y weekly
    actives (page_views), $Z per active account; Deepgram $A (B min); DB C GB"*.
  - **Database size:** add a `db.size` alert from `pg_database_size()` at 75% of whatever
    threshold you pick, for example 50 GB.
- **Files:**
  - `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`
  - `src/lib/admin-metrics.ts` (weekly actives)
  - `src/lib/infra-costs.ts`
- **Effort:** 1 day.
- **Expected savings @1k / @10k:** $0 direct. You see a bad week the same week.
- **Risk:** low.
- **Verification:**
  - Smoke test with seeded `usage_events` and `speech_usage` rows crossing each threshold
    produces each alert exactly once (the reminder rules in `ops-alerts.ts:130-134` apply).
  - The Monday message renders against PGlite.

### P1.8 Abuse protection for free metered resources (U5)
- **Approach:**
  - **Dashboard:** P1.1's Clerk settings come first.
  - **Code:** Free accounts get their Deepgram minutes (and credits, if D6 resumes them) only
    after the account is 24 h old **and** its email is verified. Before that they use their own
    key or the browser's speech recognition.
  - **Alert:** a `signup.burst` alert from the Clerk `user.created` webhook when sign-ups per hour
    exceed 5× the trailing average.
  - **Scripted uploads:** a per-account daily cap on file transcriptions (e.g. 20 per day on Free).
  - **Global bound:** P1.3's 90% rung caps the total exposure to farming.
- **Files:**
  - `src/lib/speech-quota.ts`, `src/lib/ai-access.ts`
  - `src/app/api/webhooks/clerk/*`
  - `src/lib/rate-limit.ts`
  - `src/lib/ops-alerts.ts`
- **Effort:** 1 day.
- **Expected savings @1k / @10k:** prevents farming loss. A farmed account costs about $0.80 a
  month at the cap.
- **Risk:** low–medium. ⚠️ A new Free user's first day has no Orbit-paid voice notes, so say
  so in the UI.
- **Verification:**
  - Smoke test: a 1-hour-old Free account is denied a speech token and its UI shows the fallback.
  - A fake burst of `user.created` events raises the alert.

### P1.9 Monthly reconciliation (already written)
- **Approach:** run `cost/reconcile/reconcile.mjs` on the 3rd of each month against invoices
  typed into a **private** file. The read-only export queries are in
  `cost/unit-economics/README.md`.
  - **Nothing to wire up:** it is a local script, by design. No vendor tokens enter the app.
  - **Optional, later:** automate it in the private ops repository with the same files.
- **Files:** `cost/reconcile/*`, done.
- **Effort:** 20 minutes a month.
- **Risk:** none.
- **Verification:** `node cost/reconcile/reconcile.mjs cost/reconcile/example/invoices.json cost/reconcile/example/admin-export.json` runs and exits 1 on the fake mismatches.

---

## Phase 2: high-savings, low-risk optimizations

Ranked by @10k savings. Each one ships separately, with its own smoke test.

| # | Change | Approach and files | Effort | Saves @1k / @10k | Risk | Verification |
|---|---|---|---|---|---|---|
| P2.1 | **DONE.** **Close idle dictation sockets** (F4) | Use the `vad_events` / `UtteranceEnd` already requested. Close after 10 s with no speech, reopen on the next voiced frame. `src/lib/use-dictation.ts:850-859`, `src/lib/dictation.ts` | 1 day | ~$70–110 / ~$570–850 | Low (≤1 s latency on resume) | Compare Deepgram-billed seconds for a scripted 2-minute session with 60 s of silence, before and after |
| P2.2 | **DONE as an off-switch, default on.** **Keyterms only where they help** (F6) | Send `keyterm` only for meetings with known attendees or contacts mentioned, not the global vocabulary on every request. `src/lib/deepgram-params.ts:110`, the callers | Half a day + eval | ~$30 / ~$200 | Low–medium (accuracy) | Re-run the transcription evals in `docs/ai-evals/` (2026-09-23 files); no drop in name accuracy |
| P2.3 | **DONE.** **Stop Deepgram double billing** (F7, U3) | Claim the chunk `(session, seq)` with an insert before transcribing, not after. On retry, return the stored transcript. Skip chunk upload when live coverage is ≥ 95%. `src/lib/meeting-sessions.ts:452-518`, `src/app/api/capture/meetings/[id]/chunks/route.ts:30-34`, `src/lib/meeting-live-coverage.ts:58-69` | 1 day | ~$14–36 / ~$68–181 | Low | Smoke test: two concurrent uploads of the same seq → one Deepgram call (mocked) |
| P2.4 | **Drop the duplicate jsonb embedding** (F8) | ⚠️ Only after a successful restore drill (RUNBOOK says "not yet run"). (1) On Neon, write `embedding_vector` directly and stop writing jsonb (keep jsonb on PGlite, which has no pgvector). (2) Null out jsonb in batches of 1k where the vector is present. (3) Pass `outputDimensionality: 1536` to Gemini. `src/lib/embedding-backfill.ts`, `src/lib/memory-chunks.ts`, `src/lib/ai.ts:1796`, `src/app/api/imports/process-stalled/route.ts:333-339`, `src/lib/contact-merge.ts:487-522` | 2 days | ~$13 / ~$106 (and growing). Smaller backups and faster restores. | Medium (data migration; embeddings can be regenerated, but only on the user's own key or credits) | README query 3 before and after; hybrid-search eval (`npm run eval:retrieval`) unchanged |
| P2.5 | **Vercel Analytics only on marketing pages; Speed Insights at 10%** (F9) | Render `<VercelTelemetry/>` in the marketing layout only, and set `sampleRate`. The app keeps its own `PageviewBeacon`. `src/app/layout.tsx:84`, `src/components/analytics/vercel-telemetry.tsx` | 1 hour | ~$5–15 / ~$50–150 ⚠️ | Low | Vercel → Usage events drop the next day |
| P2.6 | **Meter web-search fees and cron foreground spend** (U9). Do this before D6. | Add a per-search cost to `usage_events` for hosted web search. Mark cloud-notes auto-extract as background. `src/lib/ai.ts:2731-2762`, `src/lib/ai-operations.ts`, `src/lib/cloud-notes/scan.ts:38-41` | Half a day | $0 now; protects the pools when D6 resumes AI | Low | Smoke test: a mocked search adds its fee to the hold |
| P2.7 | **Retention for log tables** (F11) | 90-day prune for `cron_runs`, `webhook_deliveries`, `outbound_webhook_deliveries`, `gate_events` and `admin_audit_log` (or 365 days for audit, your call). Null out `import_job_rows.payload` 30 days after an import is no longer revertible. Add a date bound to `costToRunPerUser`. `src/lib/event-prune.ts`, `src/app/api/imports/process-stalled/route.ts:204-261`, `src/lib/money-metrics.ts:157-161` | Half a day | <$5 / ~$10–25 | Low (do not prune `billing_events` or `stripe_processed_events`) | Smoke test with seeded old rows; README query 3 |
| P2.8 | **Move the schedule to Vercel Cron on Pro** (F14) | `ops.yml`'s own comment plans this. Port each step to `vercel.json` `crons` (Pro allows per-minute) and keep the GitHub workflow as a heartbeat-only fallback for a week. `.github/workflows/ops.yml`, `vercel.json` | Half a day | $0 / $0 (avoids ~$65–80/mo if the repo goes private) | Low; removes the 60-day schedule-disable risk | `cron_runs` shows every job's cadence unchanged for 7 days; the Better Stack heartbeat stays green |
| P2.9 | **Resize event covers; delete them with the event** (F13) | Same pipeline as capture photos (1600 px, JPEG). `src/lib/events/cover.ts:83-100` | 2 hours | <$1 / ~$2–5 | Low | Upload a 5 MB cover → stored ≤ 400 KB |
| P2.10 | **Correct stale cost comments** | "strictly BYOK" and "managed AI off" in `infra-costs.ts:9`, `costs/page.tsx:37`, `schema.ts:4808`, `.env.example:47-49`, `ai-pricing.ts:11`, `ai.ts:384`, `plan-limits.ts:27-41` | 1 hour | $0 | None | Review |

**Deliberately not recommended:**
- Dropping `mip_opt_out` (privacy) ⚠️.
- Lowering the ops cadence to let Neon scale to zero ⚠️. It would save about $10 a month and
  cost alerting speed.
- Sampling Sentry errors. It is already self-capped.
- Proxying Deepgram through the server. On Vercel that is a large build for a problem P1.3 and
  P1.4 bound more cheaply.

---

## Phase 3: pricing and packaging, for your decision

All numbers come from `node cost/unit-economics/model.mjs`. The usage mix is a guess until you
run the README queries.

**Where the money goes today.** Deepgram is 85–95% of variable cost. Until the $15k credit runs
out, it is paid from the credit rather than cash, so the levers below decide how long the credit
lasts and what the margin looks like afterwards. The plan prices are fine for light and typical
users; the risk sits in the speech allowances.

| Change | Monthly margin @1k | @10k | Notes |
|---|---|---|---|
| Baseline (modelled, speech at full 2× price) | $411 | $4,712 | Free, Pro and Max only |
| Pro $8.99 → $11.99 | +$274 | +$2,739 | About +$900/mo per $1 at 10k, before any conversion effect (unknown) |
| Pro $8.99 → $6.99 | −$183 | −$1,826 | Not recommended |
| Max $19.99 → $24.99 | +$91 | +$913 | Max is the plan heavy users choose |
| Free voice notes 60 → 15 min | +$123 | +$1,226 | You chose to keep 60 while the credit funds it |
| Pro speech 5 + 5 h → 3 + 3 h (**D8**) | +$87 | +$870 | Apply to new subscribers |
| Free contact limit 500 → 250 | +$4 | +$38 | **The contact limit barely moves cost.** Decide it on conversion alone. |
| Free contact limit 500 → 1,000 | −$7 | −$66 | Same |
| Resume included AI at today's allowances (**D6**) | −$283 | −$2,828 | Free's 50 credits/mo dominate |
| … with Free 50 → 10 credits | −$168 | −$1,684 | |
| … with Free 0, Pro 300 → 150 | −$91 | −$910 | **Recommended shape if you resume** |
| Deepgram at list (no opt-out premium) | +$282 | +$2,823 | Settled by the invoice (D7) |
| Conversion +1 point | +$59 | +$590 | |
| Heavy users 13% → 25% of accounts | −$241 | −$2,606 | The main downside risk; the credit ladder bounds it |

### The Deepgram credit (D10)

| Accounts | Deepgram / month | $14,250 usable credit lasts |
|---|---|---|
| 1,000 | ~$630 (2×) / ~$350 (list) | ~22 / ~41 months |
| 10,000 | ~$6,300 (2×) / ~$3,500 (list) | ~2.3 / ~4 months |

The app spends 95% of the credit at most, then every surface falls back as described in D2. The
ops sweep says when each rung takes effect and when fewer than 45 days remain. When the credit is
topped up, raise `DEEPGRAM_CREDIT` in `src/lib/speech-cost.ts` (and move `since` if the new
balance starts fresh), then redeploy.

### Included AI (D6)

The provider pools already make the worst case finite: about $190/month plus a one-time $950.
- **Order:** P2.6 first, then resume for Pro and Max.
- **Free:** keep at 0–10 credits.

### Annual billing (F10)

Annual already saves "two months free", and each annual subscriber also saves about $0.32 a
month in Stripe fixed fees. Defaulting the toggle to annual is a free nudge.

---

## Phase 4: ongoing review cadence

| When | What | Time |
|---|---|---|
| **Weekly** (automatic, P1.7) | Read the Monday Slack line: spend, $/active account, Deepgram minutes, DB size. Look into any week over 120% of the last four. | 2 min |
| **Monthly** (3rd) | Type the invoices into the private file and run `cost/reconcile`. Enter `infra_costs` for the month. Update `inputs.json` with README queries 1–6 and rerun the model. File anything that failed. | 30 min |
| **Quarterly** | Re-check every ⚠️ rate in `inputs.json` against its URL and update `checked`. Re-read the vendor plan pages for tier changes. Review `MANAGED_AI_POOLS` against provider balances. Run the restore drill (RUNBOOK). | 1–2 h |
| **On events** | Before releasing a coming-soon surface (Outreach, Radar digest), re-run the model with its volumes. On any vendor pricing email, rerun the model. When crossing 1k / 10k accounts, re-read §3 of `COST_AUDIT.md`. | — |

---

## Suggested order of what is left

1. **P1.1** dashboards, today: Neon plan, vendor spend alerts, Clerk bot protection. Also set
   `ORBIT_MONTHLY_BUDGET_CENTS` in Vercel, and check `DEEPGRAM_PROJECT_ID` is set so the nightly
   reconciliation runs.
2. **P1.5, P1.6** (half a day).
3. **P1.4, P1.8** (2–3 days). These matter more now that Free farming draws on the credit.
4. **P2.5, P2.6, P2.7, P2.9, P2.10** (each small).
5. **P2.2** turned off only after its eval; **P2.4** after the restore drill; **P2.8** with Vercel Pro.
6. **Phase 3:** your decisions D6–D10, then the copy, Terms and `plan-config.ts` changes they imply.
