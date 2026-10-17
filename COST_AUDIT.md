# Orbit cost audit

Phase 1 (audit only). Date: **2026-10-17**. Commit audited: `bf1b4ae`.
Nothing in `src/`, the workflows or any vendor configuration was changed. The model and the
reconciliation check live in `cost/`; the plan is in `COST_PLAN.md`.

**How rates are labelled.** Every vendor rate below has a source URL and the date it was
checked (2026-10-17).

- **✅ confirmed**: read from the vendor's own published source.
- **⚠️ unconfirmed**: this session's network policy refused the vendor's pricing pages (HTTP 403 at
  the proxy for vercel.com, clerk.com, stripe.com, deepgram.com, resend.com, sentry.io,
  betterstack.com, microlink.io, apollo.io, twilio.com, ai.google.dev, openai.com). The figure is
  a search-engine excerpt from the vendor's own domain. Open the URL and confirm it before you
  rely on it.
- **📐 measured**: measured in this repo on seeded data.
- **🔧 code**: read from Orbit's source.
- **🎲 guess**: an assumption.

Neon, GitHub Actions and Sentry were confirmed from the public source repositories that build
their docs pages. Anthropic was confirmed from docs.claude.com.

---

## 0. Corrections to the brief (verified in code)

Several things in the brief no longer match the code. Each one changes the economics.

| Brief said | Code says | Where |
|---|---|---|
| Plans are Free, Pro and Lifetime | **Free, Pro ($8.99/mo, $89.99/yr), Max ($19.99/mo, $199.99/yr)**. The pricing page shows only these three. | `src/lib/plans/plan-config.ts:137-198`, `src/lib/plan-copy.ts:164` |
| Lifetime is sold, with an intro price that steps up | **Lifetime is no longer sold.** It is admin-granted only. `src/lib/lifetime-offer.ts` was deleted. `LIFETIME_INTRO_PRICE=25`, `LIFETIME_STANDARD_PRICE=75` and `LIFETIME_INTRO_SEATS=100` are unused. The Terms say existing holders keep "every Orbit Max feature" and 150 AI credits a month. The Stripe webhook still handles refunds of past Lifetime sales. | `src/lib/plan-limits.ts:39-41`, `src/lib/admin-lifetime.ts:8`, `src/lib/stripe-config.ts:47`, `src/app/(site)/(docs)/terms/page.tsx:314-317` |
| AI runs on the user's key; managed AI is off | **`MANAGED_AI_ENABLED = true`** (pricing v2). Every plan has a monthly credit allowance on Orbit's keys: Free 50, Pro 300, Max 650, Lifetime 150. 1 credit = $0.01 of provider list price. Free also gets a one-time 25. In production it is held back only by runtime switches: the admin pause (`site_settings.managed_ai_paused`, which reads as **paused** until someone sets it), `ORBIT_MANAGED_AI=off`, whether any `ORBIT_MANAGED_*_API_KEY` is set, and two provider pools (Anthropic $190 per monthly window, OpenAI $950 prepaid). The comment in `.env.example` describing it as off is stale. | `src/lib/managed-ai-policy.ts:35,53-56`, `src/lib/ai-access.ts:161-183,269-275`, `src/lib/credits/grants.ts:14-15` |
| Contact enrichment is a cost | **Apollo is bring-your-own-key only.** `hostedEnrichment=false` and `hostedEnrichmentsPerMonth=0` on every plan, so Orbit pays $0. | `src/lib/apollo.ts:137-159`, `plan-config.ts:125` |
| Email and SMS sending are costs | **SMS (Twilio) is not live.** Outreach is "coming soon", except on the two demo-workspace accounts. Resend is used for system mail: waitlist, credit notices, contact form, invites, and the Radar digest once Radar ships. One-to-one email goes through the user's own Gmail or Microsoft account. | `src/lib/outreach-send.ts:41-60`, `src/lib/surface-visibility.ts:251-258` |
| Speech-to-text is a cost | Confirmed. **Orbit pays Deepgram on every plan, Free included** (1 h of voice notes a month). It is the dominant variable cost: about 90% of the modelled variable spend. | `plan-config.ts:142-194`, `src/lib/deepgram.ts` |
| (not listed) | **Production appears to be on Vercel Hobby, and possibly Neon Free.** `ops.yml` says "when Vercel Pro lands"; log retention assumes Hobby; an older plan says "stay on Hobby and Neon free tier" and notes that Hobby forbids commercial use while live Stripe is on. | `.github/workflows/ops.yml:3,9`, `src/lib/perf-trace.ts:6`, `docs/superpowers/plans/2026-09-10-production-readiness.md:38-46` |
| Backups are a cost | The backup workflow moved to a private ops repository (commit `77d28a7`). It produces daily `age`-encrypted dumps kept 90 days as GitHub artifacts. The restore drill is logged as **"not yet run"**. | `docs/RUNBOOK.md:217,251,266` |

---

## 1. Cost inventory

### 1a. Rate card (every rate the model uses)

| Vendor | Item | Rate | Status | Source (checked 2026-10-17) |
|---|---|---|---|---|
| Vercel | Pro platform fee | $20/mo per deploying seat, includes $20 usage credit | ⚠️ | https://vercel.com/pricing, https://vercel.com/changelog/included-pro-usage-is-now-credit-based |
| Vercel | Hobby commercial use | Not allowed ("restricted to non-commercial personal use only") | ⚠️ | https://vercel.com/docs/limits/fair-use-guidelines |
| Vercel | Fluid compute | $0.128/CPU-hr active, $0.0106/GB-hr memory, $0.60/1M invocations. Hobby includes 4 CPU-hr, 360 GB-hr, 1M invocations | ⚠️ | https://vercel.com/docs/functions/usage-and-pricing |
| Vercel | Flat Rate CDN (Pro) | 1M requests + 1 TB included; $20 (10M), $100 (50M), $300 (150M) | ⚠️ | https://vercel.com/docs/pricing/flat-rate-cdn |
| Vercel | Blob | $0.023/GB-mo, $0.40/1M simple ops, $5/1M advanced ops, $0.05/GB transfer. Hobby: 1 GB, and access stops at the limit | ⚠️ | https://vercel.com/docs/vercel-blob/usage-and-pricing |
| Vercel | Web Analytics / Speed Insights | $0.03/1k events. Speed Insights: 10k events free, then Plus at $10/project + $0.65/10k | ⚠️ | https://vercel.com/docs/analytics/limits-and-pricing, https://vercel.com/docs/speed-insights/limits-and-pricing |
| Vercel | BotID | Basic free; Deep Analysis $1/1k checks | ⚠️ | https://vercel.com/docs/botid |
| Vercel | Cron | Hobby: once a day; Pro: once a minute, 100 jobs | ⚠️ | https://vercel.com/docs/cron-jobs/usage-and-pricing |
| Vercel | Spend management | Default $200 on-demand budget with alerts; pausing at the limit is opt-in | ⚠️ | https://vercel.com/docs/spend-management |
| Neon | Compute | Launch $0.106/CU-hr, Scale $0.222/CU-hr. Free: 100 CU-hr/project/mo | ✅ | https://neon.com/docs/introduction/plans (source `neondatabase/website` plans.md, updatedOn 2026-10-13) |
| Neon | Storage | $0.35/GB-mo. Free: 1 GB/project, 20 GB per account | ✅ | same |
| Neon | Instant-restore history | $0.20/GB-mo. Launch up to 7 days, Scale up to 30. Free: 6 h | ✅ | same |
| Neon | Egress | 500 GB/project, then $0.10/GB. Free: 5 GB | ✅ | same |
| Neon | Scale to zero | After 5 min on Free and Launch | ✅ | same |
| Clerk | Free | 50,000 monthly retained users | ⚠️ | https://clerk.com/pricing, https://clerk.com/changelog/2026-02-05-new-plans-more-value |
| Clerk | Pro | $25/mo ($20 annual); $0.02/user for 50k–100k | ⚠️ | https://clerk.com/pricing |
| Stripe | Cards | 2.9% + 30¢; +1.5% international; +1% currency conversion; $15 dispute | ⚠️ | https://stripe.com/pricing |
| Stripe | Billing | 0.7% of recurring volume | ⚠️ | https://stripe.com/billing/pricing |
| Deepgram | Nova-3 streaming | $0.0077/min list (a $0.0048 promo also shown) | ⚠️ | https://deepgram.com/pricing |
| Deepgram | Nova-3 pre-recorded | $0.0043/min | ⚠️ | https://deepgram.com/pricing |
| Deepgram | Add-ons | Diarization $0.0020/min, keyterm prompting $0.0013/min | ⚠️ | https://deepgram.com/pricing |
| Deepgram | `mip_opt_out=true` | Third-party reviews say opting out of the Model Improvement Program forfeits a 50% discount, i.e. **2× the list rate**. Deepgram's own docs only link to "pricing impacts". | ⚠️ | https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program, https://www.gladia.io/blog/deepgram-pricing |
| Deepgram | Concurrency (pay-as-you-go) | 150 streams | ⚠️ | https://developers.deepgram.com/reference/api-rate-limits |
| Anthropic | Claude Haiku 5.5 (managed default) | $0.10 / $0.50 per MTok in/out | ✅ | https://docs.claude.com/en/docs/about-claude/pricing |
| OpenAI | gpt-4o-mini, text-embedding-3-small | Embedding $0.02/MTok | ⚠️ | https://developers.openai.com/api/docs/models/text-embedding-3-small |
| Resend | Free | 3,000/mo and **100/day** | ⚠️ | https://resend.com/pricing, https://resend.com/docs/knowledge-base/account-quotas-and-limits |
| Resend | Pro / Scale | $20 for 50k (or $35 for 100k; the two pages disagree); Scale $90 for 100k; $0.90/1k overage | ⚠️ | https://resend.com/pricing |
| Twilio | US SMS (not live) | $0.0083/segment + carrier fee $0.0035–0.005; number $1.15/mo; 10DLC $4.50–46 brand + $1.50–10/mo campaign | ⚠️ | https://www.twilio.com/en-us/sms/pricing/us |
| Sentry | Paid plan quota / overage | 50k errors, 5M spans included; PAYG errors $0.0003625 each (50k–100k). Over budget, data is **dropped, not billed**. | ✅ | https://docs.sentry.io/pricing/ (source `getsentry/sentry-docs` docs/pricing/index.mdx) |
| Sentry | Developer / Team | Free: 5k errors, 1 user. Team $26/mo annual ($29 monthly) | ⚠️ | https://sentry.io/pricing/ |
| Better Stack | Free | 10 monitors, 10 heartbeats, 3-min checks | ⚠️ | https://betterstack.com/pricing |
| Microlink | Free / Pro | 25/day free (other pages say 50); Pro $49/mo for 46k requests | ⚠️ | https://microlink.io/pricing |
| GitHub Actions | Public repos | Free on standard hosted runners | ✅ | https://docs.github.com/en/billing/concepts/product-billing/github-actions |
| GitHub Actions | Private repos | 2,000 min/mo included (Free), then $0.006/min Linux; **each job rounded up to a whole minute** | ✅ | https://docs.github.com/en/billing/reference/actions-runner-pricing |
| GitHub Actions | Schedules | Disabled on public repos after 60 days without activity | ✅ | same source (`scheduled-workflows-disabled.md`) |
| Domains | .com renewal | About $10–11/yr at cost (Cloudflare) | ⚠️ | https://developers.cloudflare.com/registrar/ |
| Slack | Incoming webhooks | No charge found; 1 msg/s; free plan shows 90 days of history | ⚠️ | https://docs.slack.dev/apis/web-api/rate-limits/ |

### 1b. Inventory by vendor

Each row is something Orbit pays for, or would pay for once a switch is flipped.

| # | Vendor (plan or tier) | Used for | Pricing model | Code path that spends | Capped / metered per user? | Spend alert? | Kill switch |
|---|---|---|---|---|---|---|---|
| 1 | **Deepgram** (pay-as-you-go 🎲) | Meeting transcription (live, diarized), chat mic dictation (live), voice notes and audio uploads (file), meeting chunk recovery (file) | Per audio minute + add-ons | `src/lib/deepgram-live.ts` (browser → `wss://` on Orbit's grant token), `src/app/api/capture/meetings/[id]/stream-token`, `src/app/api/speech/token`, `src/lib/deepgram.ts:90-116` via `src/lib/ai.ts:925-984`, `src/lib/meeting-sessions.ts:489-502` | Per user, per month, two meters (`speech-limits.ts`). Checked **before** each token or file, server-side, as "not yet exhausted". **Live usage is self-reported by the browser** (`meeting-sessions.ts:645-722`, beacon for dictation). No server-side stop mid-stream. | Nightly per-session/per-user reconciliation → Slack (`/api/ops/speech-usage`). **No global or dollar alert.** | `ORBIT_DEEPGRAM=off` (new sessions only; open sockets keep running) |
| 2 | **Vercel** (Hobby 🔧 per comments) | Hosting, functions, CDN | Platform fee + usage | Every request; `src/proxy.ts` runs on all pages and `/api/*` | n/a | None in code; Vercel's own spend management (Pro) | Vercel pause (Pro) |
| 3 | Vercel Blob | Avatars (256px JPEG), capture photos (1600px), email attachments (7-day TTL), feedback screenshots, **event covers (up to 5 MB, not resized)** | GB-month + ops + transfer | `src/lib/avatar-blob.ts`, `capture-photos.ts`, `email/attachments.ts`, `events/cover.ts:83-100` | Per-upload size caps; no total cap | None | Unset `BLOB_READ_WRITE_TOKEN` (falls back to inline Postgres) |
| 4 | Vercel Analytics + Speed Insights | Page analytics, web vitals | Per event | `<VercelTelemetry/>` in the root layout, **every page including the app, no sampling** (`src/components/analytics/vercel-telemetry.tsx:26-31`) | No | None | Remove the component |
| 5 | Vercel BotID | Waitlist bot check | Basic free; Deep $1/1k | `src/lib/bot-check.ts:13-28` | Waitlist POSTs only | None | Fails open |
| 6 | **Neon** (Free or Launch: **verify** 🎲) | Postgres (neon-http) | CU-hours + GB-months + history | Every query; ops schedule every 10 min keeps compute awake | No per-user storage cap beyond Free's 500 contacts | **None** (no DB-size alert; `pg_total_relation_size` is never used) | n/a |
| 7 | Clerk (Free 🎲) | Auth | Monthly retained users | `src/proxy.ts`, hourly orphan sweep | n/a | None | n/a |
| 8 | Stripe | Pro/Max subscriptions, $5 credit packs, legacy Lifetime refunds | % + fixed per charge + Billing 0.7% | `src/actions/billing.ts:112-176` | n/a | `stripe.checkout_error`, `stripe.unattributed` (critical) | n/a |
| 9 | **Anthropic** (managed, $200/mo credit, pool $190) | Included AI: chat, capture, briefs, Radar, work history, embeddings fallback | Per token | `src/lib/ai-access.ts` (the only file holding managed keys) | Credits per account (hold, then settle), background floor 50%, model allowlist, provider pool | `ai.managed_pool` at 75%, `ai.managed_spend_spike` ($10/day), `ai.managed_runway` (>50% of revenue), `ai.managed_cap_hit` | Admin pause, `ORBIT_MANAGED_AI=off`, unset key |
| 10 | **OpenAI** (managed, $1,000 prepaid, pool $950) | Same, second in order; Whisper transcription fallback | Per token / per minute | same | same | same | same |
| 11 | Gemini | Managed in dev only; production holds no managed Gemini key | — | — | — | — | — |
| 12 | **Resend** (Free 🎲) | Waitlist welcome and referral-tier emails, credit notices (2/user/mo max), contact form, site invites, waitlist broadcasts, Radar Monday digest (opt-out, once Radar ships) | Monthly tier + overage | `src/lib/interest-list-email.ts`, `credits/notices.ts:183`, `radar/digest.ts:201`, `broadcasts.ts` | Welcome: 200/hour global. Digest: 1/user/week. **Referral-tier emails: no global cap.** | `resend.rejected` | **None** (unset the key or FROM address) |
| 13 | Twilio (not configured 🎲) | Outreach SMS (not shipped) | Per segment + number + 10DLC | `src/lib/outreach-send.ts:182-205` | 50/day/user combined with email, check-then-send (racy) | None | **None** (only the coming-soon flag) |
| 14 | Microlink (optional key) | LinkedIn headshot lookup | Free 25/day; Pro per month | `src/lib/contact-avatar.ts:112-128,585-650` | 5/day/user/source. **The 25/day global cap is skipped when the key is set.** | `avatar.source_exhausted` (watches the free bucket only) | Unset the key |
| 15 | Apollo | Enrichment | BYOK | `src/lib/apollo.ts` | Hosted path off | `apollo.hosted_cap_hits` | Flag off |
| 16 | Sentry (Developer 🎲) | Errors, 10% traces, no replays | Event quota; over quota is dropped | `sentry.*.config.ts`, `src/lib/sentry-browser.ts:18-20` | Self-capped by quota | Sentry's own | Unset DSN |
| 17 | Better Stack (Free 🎲) | Uptime monitor, ops heartbeat, backup heartbeat | Free tier | `ops-sweep.ts:335-347` | — | It *is* the alert | — |
| 18 | GitHub Actions (public repo) | CI (check + 3 smoke shards + Playwright), extension CI, **ops scheduler (~386 job runs/day)**, backups (private repo) | Free while public; per minute if private | `.github/workflows/*.yml` | — | ops.yml fails red when misconfigured | — |
| 19 | Slack | Ops alerts, DMs | Free | `src/lib/ops-notify.ts`, `slack-dm.ts` | — | — | — |
| 20 | Domains (2: app + waitlist) | DNS | Annual | — | — | — | — |
| 21 | Google / Microsoft APIs, Eventbrite, Luma, iCloud | Sync, import, calendar | Free quotas on user OAuth | `sync-scheduler.ts` (20 connections per 15-min run) | Per-run batch caps | `sync.*` alerts | — |
| 22 | TypeSafe (Jev) | Decision model | BYOK only | `src/lib/decisions/` | — | — | `ORBIT_JEV=off` |
| 23 | Backup storage | Daily encrypted dumps (private repo artifacts, 90 days) | GitHub artifact storage: 500 MB free, then $0.25/GB-mo (private) ✅ | private ops repo | — | Better Stack heartbeat (36 h) | — |

**Fixed versus variable.** At today's scale, fixed spend is about $40–45/month:

| Item | $/month | Basis |
|---|---|---|
| Vercel Pro | $20 | Required, see F0 |
| Neon compute floor | ~$19 | 0.25 CU kept awake by crons, on Launch |
| Domains | ~$2 | 2 domains |
| Everything else | $0 | On free tiers |

Per-user variable cost is almost entirely Deepgram. Per-event costs are Stripe's 30¢ plus percentage, Resend sends above the free tier, and Microlink lookups when the key is set.

---

## 2. Spend with no cap or no kill switch

Ordered by how much a bad day could cost.

| ID | What | Why it can run away | Today's protection |
|---|---|---|---|
| **U1** | **Deepgram live streams** (meetings, dictation) | The browser holds Orbit's grant token and streams straight to Deepgram. The server checks the allowance only when it issues the 30-second token; the socket outlives the token, and **nothing server-side can close it**. The meeting cut-off (`use-meeting-live.ts:515,630-634`) and the 3-hour meeting cap are client-side. Dictation never receives `remainingSeconds` (`use-dictation.ts:41`); its only stop is a client 5-minute timer. Usage is metered from what the browser reports (segment `endMs`, a `sendBeacon` for dictation). A modified client can stream for as long as it likes, choose the model and add-ons, and drop the reconciliation tag. | Token minting: 30 per 5 min per user. Nightly reconciliation alerts the next day, but **skips untagged requests silently** (`api/ops/speech-usage/route.ts:351`) and stops reading after 50 pages of 1,000 requests. |
| **U2** | **No global Deepgram budget, and no dollar figure anywhere** | Live streams write no `usage_events` row; file rows carry no cost; `managed-ai-ops.ts:26` excludes Deepgram on purpose. The Money, runway and ops screens show **$0 of Deepgram**. | None. `ORBIT_DEEPGRAM=off` stops new sessions only. |
| U3 | Deepgram double billing | (a) Two uploads of the same chunk both transcribe, because the dedupe check runs before transcription (`meeting-sessions.ts:452`) and uniqueness is enforced only after (`:518`). (b) A 502 after Deepgram succeeded is retried and billed again (`chunks/route.ts:30-34`). (c) Chunks with 3 s or more uncovered are re-uploaded even though the live socket billed most of them (`meeting-live-coverage.ts:58-69`). The user's meter is a high-water mark, so the user isn't double-charged, but Orbit is. | None |
| U4 | Short-form file overshoot | Each file is checked as "not exhausted", then billed in full: up to 3 files × 12 MB per capture with 1 s of allowance left (`ai.ts:940`, `capture-ingest.ts:38-40`). The 6-minute recording cap is client-side. | Capture rate limit 30/min |
| U5 | **Free-account farming** | Each Free account gets 1 h of Deepgram a month (and 75 credits if included AI is resumed). There is **no disposable-email check, no multi-account detection, and no bot check on sign-up**; BotID covers only the waitlist. | Clerk sign-up mode (dashboard); stealth/invite mode while it is on |
| U6 | Hosted outreach (Resend, Twilio) | `hostedSending: true` on Pro, Max and Lifetime. Only the coming-soon flag stops Orbit's Resend/Twilio keys being used, and **the two demo-workspace accounts already bypass it** (`surface-visibility.ts:251-258`). The 50/day cap is check-then-send and can be raced. | Coming-soon flag; Twilio keys probably unset |
| U7 | Resend system mail | No env kill switch. Waitlist referral-tier emails have no global cap. The 200/hour welcome cap is far above Resend Free's 100/day, so a waitlist spike gets mail **rejected**, not billed. Bounce/complaint suppression covers only the waitlist table. | `resend.rejected` alert |
| U8 | Microlink | With `MICROLINK_API_KEY` set, the global 25/day cap is skipped (`contact-avatar.ts:120`). Spend scales as 5 lookups × active users per day, and no alert watches paid volume. | Per-user 5/day |
| U9 | Included AI, if resumed | One admin toggle turns on Orbit-paid AI for **Free accounts too**. Web-search fees are not counted in credits or pools (`ai.ts:2741-2742`). Cloud-notes auto-extract spends foreground credits from a cron (`cloud-notes/scan.ts:38-41`). | Pools ($190/mo Anthropic, $950 OpenAI) are a real hard cap; per-account credits |
| U10 | Vercel usage | If Hobby: hard limits (4 CPU-hours, 1M invocations, 1 GB Blob) become **outages**. If Pro: on-demand spend up to the budget, which defaults to $200 with pausing opt-in. | Vercel defaults |
| U11 | Neon storage | Unlimited on paid plans, no alert. On Free, writes fail at 1 GB. | None |
| U12 | Blob | Event covers stored unresized, kept until the account is deleted; saved capture photos kept forever. | Per-upload caps |

---

## 3. Unit economics (summary of `cost/unit-economics`)

The default scenario: included AI paused, and the Deepgram opt-out premium (2×) applied. The
`--mip 1` run shows list price. **Usage profiles and the plan mix are guesses**; replace them
with the README queries.

| Plan | Net revenue/mo after Stripe | Light | Typical | Heavy | Abusive |
|---|---|---|---|---|---|
| Free | $0 | $0.05 | $0.19 | **$0.84** (all caps used) | $8.74 (modified client) |
| Pro | $7.99 | $0.21 | $2.21 (list: $1.28) | **$9.63** (list: $5.52) | $21 |
| Max | $18.03 | $0.40 | $4.38 (list: $2.50) | **$19.08** (list: $10.86) | $31 |
| Lifetime | $0 recurring | $0.40 | $4.38 | **$19.08** | $31 |

- **Pro and Max lose money on a user who maxes their speech allowance** at the 2× rate (−$1.64
  and −$1.04 a month). At list price they keep 31% and 40%.
- **Lifetime (legacy cohort):** at the $25 intro price, a typical user costs more than they paid
  within ~6 months, and a heavy one within ~5 weeks. Over 3 years, one heavy Lifetime user erases
  the margin of ~71 light ones at $25, or ~11 at $75. A cohort of 100 Lifetime accounts costs about
  **$460/month** to run: more than all fixed platform costs at 1,000 users.
- **Free:** a Free user who uses every metered feature costs $0.84/month; the blended Free user
  costs $0.37. Pro needs **6% of signups paying** to carry blended Free users, or 13% if every Free
  user maxes their voice notes. Resuming included AI for Free raises that to 10% and 23%.
- **Break-even:** about 31 subscribers covers platform costs at the guessed mix, or **~195 once the
  100-account Lifetime cohort's running cost is included** (~70 at Deepgram list price).
- **Scale:** cost per account falls from $1.33 (100) to $0.69 (50,000). Speech is 85–95% of
  variable spend at every scale point. DB storage is the next biggest line and grows with
  embeddings.

**Pricing cliffs, in the order you hit them:**

| When | Cliff | Consequence |
|---|---|---|
| **Now** | Vercel Hobby forbids commercial use. Hobby limits (4 CPU-hours, 1 GB Blob) become outages. | Upgrade, $20/mo |
| **Now / under 100 users** | **Neon Free: 1 GB storage and 100 CU-hours per project.** The ops schedule alone keeps a 0.25 CU compute awake ~730 h/month ≈ 183 CU-hours. A typical account is ~50 MB with embeddings, so 1 GB is about 20–60 accounts. | Free suspends compute and fails writes |
| ~200 users (once Radar ships) | **Resend Free 100/day.** The Monday digest goes out over two days. | Mail rejected → $20/mo |
| ~250–300 users | Vercel Flat Rate CDN 1M requests. | $20 → $100 → $300 tiers |
| If the repo goes private | **GitHub Actions**: ~386 scheduled jobs a day, each billed as at least 1 minute, ≈ 11.6k min/mo plus CI, against 2,000 included. | ≈ $65–80/mo |
| ~10k–50k users | Sentry Free 5k errors. | Data dropped until Team ($26/mo) |
| ~50k users | **Deepgram pay-as-you-go: 150 concurrent streams** (reliability). | New meetings fail to connect |
| ~90k registered users | Clerk 50k retained users. | $25 + $0.02/user |

---

## 4. Efficiency findings, ranked by monthly savings

Savings are from `node cost/unit-economics/model.mjs` (sensitivity table) at 1,000 / 10,000 accounts,
2× Deepgram rate. Every figure inherits the model's guesses.

| Rank | Finding | Saves /mo @1k | Saves /mo @10k | Risk |
|---|---|---|---|---|
| F0 | **Required spend, not savings:** Vercel Pro (+$20); Neon Launch if on Free (+$20–40 @1k); Resend Pro once mail exceeds 100/day (+$20) | −$40 to −$80 | −$60 to −$150 | Reduces risk (ToS, outages) |
| F1 | **Deepgram opt-out premium.** `mip_opt_out=true` on every request (`deepgram-params.ts:113-117`) may double the per-minute rate. Your invoice settles it: the effective $/min is printed by `cost/reconcile`. | up to $453 | up to $2,993 | ⚠️ **Removing the flag trades away customer privacy (vendor training on private meetings). Not recommended.** Safer levers: a Deepgram Growth commitment (~15–20% off ⚠️), or asking Deepgram for zero-retention at a negotiated rate. |
| F2 | **Free voice-note allowance** 60 → 15 min/month | $110 | $1,214 | Low (pricing; Free voice notes still work on the user's own OpenAI/Gemini key) |
| F3 | **Pro speech allowance** 5 h + 5 h → 3 h + 3 h | $78 | $861 | Low–medium (pricing; existing subscribers need notice) |
| F4 | **Dictation sockets stay open through silence** (`use-dictation.ts:850-859`); live meeting sockets bill silence. Closing dictation after ~10 s of no speech (VAD events are already requested). Assumes 20–30% of streamed short-form minutes are idle 🎲 | ~$70–110 | ~$570–850 | Low (≤1 s reconnect latency on resume) |
| F5 | **Lifetime speech allowance** 10 h + 10 h → 3 h + 3 h on Orbit's key, with the user's own key beyond | $304 | $304 (cohort of 100) | ⚠️ Terms promise "every Orbit Max feature"; needs a Terms change and notice. See decision D4. |
| F6 | **Keyterm add-on on every request** (`deepgram-params.ts:110`). Send keyterms only where they change accuracy (names of attendees, not a global vocabulary). The add-on is ~$67 @1k and ~$440 @10k; assume half can go | ~$30 | ~$200 | Low–medium (accuracy; re-run `docs/ai-evals` transcription evals) |
| F7 | **Duplicate Deepgram billing** (U3): chunk race, retry-after-success, live/chunk overlap. Est. 3–8% of meeting minutes | ~$14–36 | ~$68–181 | Low |
| F8 | **Embeddings stored twice.** `contact_embeddings.embedding` and `memory_chunks.embedding` are jsonb arrays (📐 **30.7 KB** each for 1536 floats, uncompressed) kept alongside `vector(1536)` (📐 6.2 KB) and an HNSW index. The jsonb copy is ~2/3 of the database. Gemini embeddings are requested without an output dimension, so they may be 3072 floats in jsonb (~61 KB). | $13 | $106, and growing with every contact; also smaller backups, faster restores, and it pushes back the Neon Free cliff | Medium (migration; jsonb is the PGlite fallback). Do it only after a verified restore drill. |
| F9 | **Vercel Analytics + Speed Insights on every app page, unsampled.** The app already has its own `PageviewBeacon`. Limit Vercel's to marketing pages, or sample at 10%. | ~$5–15 ⚠️ | ~$50–150 ⚠️ | Low |
| F10 | **Stripe:** annual billing pays one 30¢ fee a year instead of twelve (−$0.32/subscriber-month). Credit packs pay ~9% in fees. | ~$10 | ~$100 | Low (pricing nudge) |
| F11 | **Unpruned tables:** `cron_runs` (~1k rows/day), `webhook_deliveries`, `gate_events`, `outbound_webhook_deliveries` (payload JSON), `admin_audit_log`, `import_job_rows` (full LinkedIn message transcripts in `payload`). Also `costToRunPerUser` scans all of `usage_events` with no date filter (`money-metrics.ts:157-161`). | <$5 | ~$10–25 | Low (keep the billing ledger; prune logs at 90–180 days) |
| F12 | **Microlink with a key has no global cap** (U8) | $0–150 (only if key set) | $0–300 | Low |
| F13 | **Event covers up to 5 MB, unresized** in Blob; deleting an event leaves its cover | <$1 | ~$2–5 | Low (also avoids the Hobby 1 GB cliff) |
| F14 | **Move the ops schedule to Vercel Cron once on Pro** | $0 (public repo) | $0 | Cost-neutral today. **Avoids ~$65–80/mo if the repo goes private**, and removes the 60-day schedule-disable risk. |
| F15 | Neon compute is kept awake by the ops schedule (~$19/mo floor at 0.25 CU on Launch) | ~$5–10 if cadence halved | same | ⚠️ **Not recommended:** the alerting cadence is worth more than $10/mo |

**Hosting specifics checked:**

- **Functions:** serverless cost per dynamic request is tiny (≈ $4.5 per million requests in
  the model).
- **Polling:** presence (45 s) and app pulse (90 s) both pause in hidden tabs, which is already
  efficient.
- **Images:** there is no `next/image` optimization of remote images and avatars are plain
  `<img>`, so image charges are ~0.
- **Middleware:** `src/proxy.ts` runs on every page and API request; setting `CLERK_JWT_KEY`
  keeps it networkless.
- **Caching:** 66 routes are `force-dynamic` and nothing uses `use cache`. That is a latency
  issue more than a cost one at this scale.

**CI/CD checked:**

- CI already skips drafts and docs-only PRs, caches `node_modules` and `.next/cache`, cancels
  superseded runs, and splits the smoke suite into three shards.
- On a public repo all of it is free.
- Redundant jobs: none worth removing. Every `main` push re-running CI is deliberate, because it
  seeds the caches.

**Seats and services:**

- No paid seats were found in code.
- Unused code: the rate-limit buckets `providerSync` and `lifetimeConfirm`, and the constants
  `LIFETIME_*`. They cost nothing.

---

## 5. What is already efficient

- **Speech:**
  - Audio is downsampled to 16 kHz mono before it leaves the browser.
  - Silent meeting chunks (<300 ms of voice) are never sent.
  - Meeting meters are high-water marks, so retries don't double-charge the user.
  - Meetings and voice notes have separate meters.
  - Grant tokens live 30 s; token minting is rate-limited.
  - There is a nightly reconciliation and a kill switch.
  - Voice notes use the cheaper pre-recorded endpoint.
- **Included AI:**
  - Credits are held then settled.
  - Provider pools are a true hard cap ($190/mo + $950).
  - There is a model allowlist (Haiku 5.5, 4o-mini, 4.1-nano), and background work stops below 50% of the allowance.
  - `ai_result_cache` (90 days) avoids paying twice.
  - Alerts exist for spike, runway, pool and cap.
  - It is paused in production by default.
- **Enrichment and SMS:** BYOK or not shipped, so $0.
- **Avatars:**
  - Cross-account dedupe by LinkedIn slug (180 days).
  - 256 px JPEG.
  - Free sources (Unavatar, Gravatar, favicons) are tried first.
- **Blob:** capture photos are resized to 1600 px; attachments are deleted 7 days after send; unsent orphans after 2 days.
- **Retention exists for:**
  - `usage_events` (180 d)
  - `error_events` (30 d)
  - `page_views` (180 d)
  - `ai_result_cache` (90 d)
  - `capture_jobs` (30 d)
  - Radar news (14 d)
  - `rate_limit_buckets` and holds
- **Monitoring:** Sentry has replays off and 10% traces, its browser SDK lazy-loads, and over-quota data is dropped rather than billed.
- **Build and deploy:**
  - PGlite WASM and `sharp` are kept out of the functions.
  - Preview builds are skipped for `claude/*` branches with no PR.
  - The browser pollers pause in hidden tabs.
- **Rate limits:** they live in Postgres and fail closed. There is a 50/day outreach cap and email recipient caps (Free 40, paid 200 per 24 h).

---

## 6. Admin cost and runway views vs actual invoices

| Screen / figure | What it does | Problem |
|---|---|---|
| Money → Costs (`src/app/(clerk)/(admin)/admin/billing/costs/page.tsx`) | Hand-entered `infra_costs` + `startup_expenses` + acquisition | Nothing checks them against invoices; a missing provider reads as "not entered" (good) but a wrong one reads as truth |
| Stripe fee estimate (`money-costs.ts:131-139`) | 2.9% + 30¢ × **chargeCount = 1** whenever any money came in (`costs/page.tsx:59`) | Undercounts 30¢ per charge after the first, omits Billing's 0.7% and international cards. On the fake fixture the screen said $9.42 against an actual $20.50 |
| Contribution per subscriber (`costs/page.tsx:65-66`) | Pro price − Stripe − 300 credits | **Leaves out Deepgram**, the largest variable cost, and the per-user Neon/Vercel cost |
| Runway (`admin-yc-metrics.ts:52-93`) | Expenses + latest infra bill + Orbit-paid AI from `usage_events` | **Deepgram is $0** (no cost rows), so burn is understated by the whole speech bill |
| `ai-pricing.ts:102-108` | Deepgram nova-3 at 72 micros/s = $0.0043/min | The pre-recorded rate; live streams are $0.0077 list (⚠️) plus add-ons, possibly ×2. The row prices nothing anyway (no tokens recorded) |
| Stale comments | "production is strictly BYOK" (`infra-costs.ts:9`, `costs/page.tsx:37`, `schema.ts:4808`), "managed AI is off" (`.env.example:47-49`, `ai-pricing.ts:11`, `ai.ts:384`) | Mislead anyone reading the Money screen's code |

**Reconciliation check written:** `cost/reconcile/reconcile.mjs`. Each month you type the
invoices into a private JSON file and export the admin tables with the read-only queries in
`cost/unit-economics/README.md`. The script then compares five things:

1. Every invoiced provider against `infra_costs`.
2. Deepgram billed minutes against `speech_usage`. A gap of 10% or more means unmetered streaming.
3. Anthropic and OpenAI invoices against `usage_events` where `key_owner='orbit'`.
4. Actual Stripe fees against the screen's estimate and against a per-charge + Billing estimate.
5. Cost per monthly active user.

It exits 1 on any failure. A demo with fake numbers lives in `cost/reconcile/example/`.

---

## 7. Free-tier headroom

| Service | Tier (assumed 🎲) | Limit | Orbit's use | Headroom |
|---|---|---|---|---|
| Vercel | Hobby | Non-commercial; 4 CPU-h; 1M invocations; 1 GB Blob | Commercial (live Stripe) | **None: out of policy today** |
| Neon | Free? | 1 GB, 100 CU-h/project | ~183 CU-h from crons alone | **None if on Free.** Check Neon → Billing now. |
| Clerk | Free | 50k retained users | — | Very large |
| Resend | Free | 3k/mo, 100/day | Waitlist bursts up to 200/hour | **Tight** on waitlist days; gone when the Radar digest ships |
| Sentry | Developer | 5k errors/mo, 1 user | — | Check Sentry → Stats |
| Better Stack | Free | 10 monitors, 10 heartbeats | 1 monitor + 2 heartbeats | Large |
| GitHub Actions | Public repo | Free | ~386 scheduled jobs/day + CI | Unlimited while public. **Schedules stop after 60 days with no commit.** |
| Microlink | Free (unless key) | 25/day | Capped at 25/day by code | At the cap by design |
| Deepgram | $200 sign-up credit | One-time | — | Check the console balance |
| Anthropic / OpenAI | $200/mo credit; $1,000 prepaid | Pools at 95% | Paused | Full |

**Vendor consolidation:** nothing worth consolidating. Every vendor is either the only one for
its job or free. The only overlap is Vercel Analytics against Orbit's own `page_views` (F9).

---

## 8. What could not be verified

1. **Most vendor prices** (⚠️ rows above): the session's network policy blocked the pricing
   pages. To allow them, add the hosts to the environment's allowed domains: Network access in
   the cloud environment settings, see https://code.claude.com/docs/en/cloud-environments#network-access.
   Or check them by hand.
2. **The Deepgram opt-out premium.** Whether `mip_opt_out=true` doubles your rate. Your Deepgram
   invoice answers it.
3. **Production settings** that live outside the repo:
   - the Vercel plan;
   - the Neon plan, min/max CU and scale-to-zero;
   - whether the managed-AI pause has been lifted;
   - which keys are set (`MICROLINK_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `DEEPGRAM_PROJECT_ID`, `ORBIT_MANAGED_*`, `TWILIO_*`);
   - Clerk's sign-up mode and bot protection;
   - Vercel's spend-management settings.
4. **Real usage.** Accounts per plan, the Lifetime holder count, speech minutes, DB size,
   monthly actives and email volume. Every profile and mix number in the model is a guess.
   `cost/unit-economics/README.md` has the exact read-only queries; fields stay as guesses
   until you run them.
5. **Backups.** The private ops repo was not visible, so artifact size, encryption and the
   untested restore were not checked.
6. **Clerk's "retained user" definition** (calendar day vs rolling 24 h) and whether Speed
   Insights bills or stops past its free events.
7. **Gemini embedding dimension in production** (3072 if `gemini-embedding-001`'s default
   applies ⚠️). Query 3 in the README shows the stored size.

**Measured on seeded data** (`scripts/seed-scale.ts`, 5,000 fake contacts on a throwaway
PGlite; not production):

| Item | Size |
|---|---|
| `contacts` | 4,127 bytes per contact, indexes included (indexes are 1.7× the rows) |
| `interactions` | 534 bytes each |
| jsonb embedding (1536 floats) | 30,724 bytes |
| `vector(1536)` | 6,168 bytes |
