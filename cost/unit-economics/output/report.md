# Orbit unit economics (model output)

Generated 2026-10-17 from `inputs.json`. Scenario: included AI **OFF (paused, BYOK only)**, Deepgram opt-out multiplier **2x**.
Every GUESS in inputs.json flows into these numbers. Treat them as orders of magnitude until the README queries replace the guesses.

## 1. Cost per user per month, by plan and usage profile

Deepgram per minute in this scenario: meeting $0.02, short-form $0.01.

| plan | profile | audio min | DB MB | speech | AI (Orbit key) | storage | hosting | email | total |
|---|---|---|---|---|---|---|---|---|---|
| free | light | 3 | 16 | $0.04 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.05** |
| free | typical | 12 | 49 | $0.16 | $0.00 | $0.02 | $0.01 | $0.01 | **$0.19** |
| free | heavy | 60 | 49 | $0.78 | $0.00 | $0.02 | $0.02 | $0.01 | **$0.84** |
| free | abusive | 660 | 49 | $8.61 | $0.00 | $0.02 | $0.09 | $0.03 | **$8.74** |
| pro | light | 15 | 16 | $0.20 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.21** |
| pro | typical | 135 | 86 | $2.17 | $0.00 | $0.04 | $0.01 | $0.01 | **$2.21** |
| pro | heavy | 600 | 376 | $9.44 | $0.00 | $0.16 | $0.02 | $0.01 | **$9.63** |
| pro | abusive | 1200 | 1872 | $20.51 | $0.00 | $0.77 | $0.09 | $0.03 | **$21.40** |
| max | light | 30 | 16 | $0.39 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.40** |
| max | typical | 270 | 86 | $4.33 | $0.00 | $0.04 | $0.01 | $0.01 | **$4.38** |
| max | heavy | 1200 | 376 | $18.89 | $0.00 | $0.16 | $0.02 | $0.01 | **$19.08** |
| max | abusive | 1800 | 1872 | $29.95 | $0.00 | $0.77 | $0.09 | $0.03 | **$30.84** |
| lifetime | light | 30 | 16 | $0.39 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.40** |
| lifetime | typical | 270 | 86 | $4.33 | $0.00 | $0.04 | $0.01 | $0.01 | **$4.38** |
| lifetime | heavy | 1200 | 376 | $18.89 | $0.00 | $0.16 | $0.02 | $0.01 | **$19.08** |
| lifetime | abusive | 1800 | 1872 | $29.95 | $0.00 | $0.77 | $0.09 | $0.03 | **$30.84** |

## 2. Revenue net of Stripe fees, and gross margin per paying user

| plan | profile | list/month | net of fees | cost | margin | margin % |
|---|---|---|---|---|---|---|
| pro | light | $8.99 | $7.99 | $0.21 | $7.78 | 97% |
| pro | typical | $8.99 | $7.99 | $2.21 | $5.78 | 72% |
| pro | heavy | $8.99 | $7.99 | $9.63 | -$1.64 | -21% |
| pro | abusive | $8.99 | $7.99 | $21.40 | -$13.41 | -168% |
| max | light | $19.99 | $18.03 | $0.40 | $17.63 | 98% |
| max | typical | $19.99 | $18.03 | $4.38 | $13.66 | 76% |
| max | heavy | $19.99 | $18.03 | $19.08 | -$1.04 | -6% |
| max | abusive | $19.99 | $18.03 | $30.84 | -$12.81 | -71% |

## 3. Lifetime: one-time revenue vs cumulative cost

| price | profile | net | cost/mo | margin after 1y | margin after 3y | margin after 5y | cost overtakes price |
|---|---|---|---|---|---|---|---|
| $25.00 | light | $23.90 | $0.40 | $19.05 | $9.35 | -$0.36 | 59.1 mo |
| $25.00 | typical | $23.90 | $4.38 | -$28.65 | -$134 | -$239 | 5.5 mo |
| $25.00 | heavy | $23.90 | $19.08 | -$205 | -$663 | -$1,121 | 1.3 mo |
| $25.00 | abusive | $23.90 | $30.84 | -$346 | -$1,086 | -$1,827 | 0.8 mo |
| $75.00 | light | $72.30 | $0.40 | $67.45 | $57.75 | $48.04 | 178.8 mo |
| $75.00 | typical | $72.30 | $4.38 | $19.75 | -$85.34 | -$190 | 16.5 mo |
| $75.00 | heavy | $72.30 | $19.08 | -$157 | -$614 | -$1,072 | 3.8 mo |
| $75.00 | abusive | $72.30 | $30.84 | -$298 | -$1,038 | -$1,778 | 2.3 mo |

- $25, 3 years: light $9.35, typical -$134, heavy -$663. **One heavy user erases the margin of 70.9 light ones.**
- $25, 5 years: light -$0.36, typical -$239, heavy -$1,121. Even light users lose money.
- $75, 3 years: light $57.75, typical -$85.34, heavy -$614. **One heavy user erases the margin of 10.6 light ones.**
- $75, 5 years: light $48.04, typical -$190, heavy -$1,072. **One heavy user erases the margin of 22.3 light ones.**

Price at which a heavy Lifetime user breaks even after 3 years: $687 (after 5 years: $1,145).

## 4. Free users

| profile | cost/month |
|---|---|
| light | $0.05 |
| typical | $0.19 |
| heavy | $0.84 |
| abusive | $8.74 |

A Free user who uses every metered feature to its cap costs **$0.84/month**; the blended Free user costs $0.37.
A blended Pro subscriber contributes $5.53/month. Conversion needed for Pro to carry Free:
- maxed Free users: **13%** of signups must pay
- blended Free users: **6%** of signups must pay (before fixed costs)

## 5. Scale points

| users | DB size | platform/fixed | variable | total cost | cost/user | net revenue (subs) | monthly margin | margin % |
|---|---|---|---|---|---|---|---|---|
| 100 | 4.8 GB | $43.31 | $106 | $133 | $1.33 | $104 | -$29.04 | -28% |
| 1,000 | 48.4 GB | $85.22 | $1,060 | $1,125 | $1.13 | $1,044 | -$81.51 | -8% |
| 10,000 | 413.9 GB | $254 | $7,029 | $7,264 | $0.73 | $11,483 | $4,219 | 37% |
| 50,000 | 2038.5 GB | $822 | $33,560 | $34,361 | $0.69 | $57,879 | $23,518 | 41% |

Lifetime revenue is one-time, so it is not in the monthly revenue column; Lifetime users' running cost is.

### Variable spend by category

| users | speech (all) | of which meetings | AI (Orbit key) | DB storage | Blob | functions | email |
|---|---|---|---|---|---|---|---|
| 100 | $103 | $45.18 | $0.00 | $1.98 | $0.06 | $0.71 | $0.69 |
| 1,000 | $1,026 | $452 | $0.00 | $19.83 | $0.58 | $7.08 | $6.93 |
| 10,000 | $6,715 | $2,259 | $0.00 | $170 | $4.95 | $70.76 | $69.30 |
| 50,000 | $31,999 | $10,292 | $0.00 | $836 | $24.34 | $354 | $347 |

### Pricing cliffs by scale point

- **100 users**: DB ~4.8 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $1.69/month); Neon compute ~185 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Neon compute $19.56, Domains $1.83
- **1,000 users**: CDN requests ~3.8M/month: past the 1M included tier; Resend: Monday digest peak ~500 emails/day, past the Free plan's 100/day; DB ~48.4 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $16.93/month); Neon compute ~203 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~4.7 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $20.00, Neon compute $21.47, Resend $20.00, Domains $1.83
- **10,000 users**: CDN requests ~38.2M/month: past the 1M included tier; Resend: Monday digest peak ~5000 emails/day, past the Free plan's 100/day; DB ~413.9 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $145/month); Neon compute ~383 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~40.2 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $100, Neon compute $40.55, Resend $90.00, Domains $1.83
- **50,000 users**: CDN requests ~190.9M/month: past the 1M included tier; Resend: Monday digest peak ~25000 emails/day, past the Free plan's 100/day; Sentry: ~10,000 errors/month, past the free 5k (excess is dropped, not billed, until you upgrade); DB ~2038.5 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $713/month); Neon compute ~1183 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~197.9 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby); ~159 concurrent Deepgram streams at peak: past pay-as-you-go's 150-stream limit (new meetings fail to connect). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $300, Neon compute $125, Resend $347, Sentry $26.00, Domains $1.83

## 6. Break-even

Fixed platform cost at ~1,000 users: $85.22/month, plus $463/month running cost of 100 Lifetime accounts. Blended Pro contribution $5.53; with 7.3 Free users per subscriber, each subscriber nets $2.83.
**Break-even: ~195 paying subscribers** at this plan mix (31 without the Lifetime cohort).

## 7. Sensitivity (monthly margin at 1,000 and 10,000 users)

| change | 1k margin/mo | 1k vs base | 10k margin/mo | 10k vs base |
|---|---|---|---|---|
| baseline | -$102 | - | $4,199 | - |
| Pro $6.99 | -$266 | -$164 | $2,392 | -$1,808 |
| Pro $11.99 | $145 | $246 | $6,911 | $2,711 |
| Max $24.99 | -$19.35 | $82.17 | $5,103 | $904 |
| Free limit 250 contacts | -$98.08 | $3.44 | $4,237 | $37.80 |
| Free limit 1,000 contacts | -$107 | -$5.95 | $4,134 | -$65.46 |
| Free short-form 60 → 15 min | $8.87 | $110 | $5,413 | $1,214 |
| Lifetime speech 10h+10h → 3h+3h | $203 | $304 | $4,504 | $304 |
| Pro speech 5h+5h → 3h+3h | -$23.25 | $78.26 | $5,060 | $861 |
| Deepgram at list (no opt-out premium) | $351 | $453 | $7,193 | $2,993 |
| Included AI resumed (current allowances) | -$405 | -$303 | $1,351 | -$2,848 |
| Included AI resumed, Free 50 → 10 credits | -$302 | -$200 | $2,484 | -$1,715 |
| Included AI resumed, Free 0, Pro 300 → 150 | -$232 | -$131 | $3,250 | -$950 |
| Conversion +1 pt (free 88% → 87%, pro +1) | -$48.39 | $53.12 | $4,784 | $584 |
| Heavy share 13% → 25% | -$542 | -$441 | $1,393 | -$2,806 |
| Embeddings: drop the duplicate jsonb copy | -$88.99 | $12.52 | $4,306 | $106 |
| Lifetime cohort 100 → 300 accounts | -$102 | $0.00 | $3,173 | -$1,026 |
| No Lifetime cohort | $411 | $513 | $4,712 | $513 |

## Assumptions that are guesses

- `rates.neon.plan` = "launch" (launch | scale (set to your actual plan))
- `rates.neon.minCu` = 0.25 (CU, autoscaling floor (check Neon console))
- `rates.neon.historyToDataRatio` = 0.3 (PITR history GB per GB of data (depends on write churn and window))
- `rates.clerk.retainedShareOfUsers` = 0.55 (share of registered users who count as retained in a month)
- `rates.stripe.internationalShare` = 0.2 (share of charges on non-US cards)
- `rates.deepgram.keytermShareOfMinutes` = 0.8 (share of minutes that carry keyterms)
- `rates.deepgram.shortformStreamingShare` = 0.5 (share of short-form minutes that stream (chat mic) vs file (voice notes))
- `rates.sentry.errorsPer1000Mau` = 400 (errors per month per 1,000 active users)
- `rates.github.ciMinutesPerPush` = 25 (billed minutes per CI run (check + 3 smoke shards + e2e))
- `rates.github.ciRunsPerMonth` = 120 (CI runs/month)
- `storage.hnswBytesPerVector` = 7000 (bytes per vector in the HNSW index (m=16 default))
- `storage.embeddingsPerContact` = 1.3 (contact_embeddings rows per contact (profile + meetings/notes))
- `storage.memoryChunksPerContact` = 0.8 (memory_chunks rows per contact)
- `storage.avatarShareOfContacts` = 0.4 (share of contacts with a stored headshot)
- `storage.avatarBytes` = 25000 (bytes per stored headshot)
- `storage.otherPerUserMb` = 2 (MB/user of chat, usage_events, settings, logs after retention)
- `hosting.cpuSecondsPerRequest` = 0.06 (active CPU seconds per dynamic request)
- `hosting.gbSecondsPerRequest` = 0.6 (provisioned GB-seconds per request (1 GB x 0.6 s wall))
- `hosting.cdnRequestsPerDynamic` = 6 (CDN requests (assets, prefetch) per dynamic request)
- `hosting.backgroundRequestsPerUserMonth` = 300 (function work per user per month from crons (sync every 15 min, radar, notes), in request-equivalents)
- `hosting.fixedCronCpuHoursMonth` = 15 (CPU-hours/month the ops.yml schedule costs with zero users)
- `plans.annualShare` = 0.3 (share of Pro/Max subscribers on annual)
- `mix.lifetimeMaxShare` = 0.1 (cap on Lifetime accounts as a share of all accounts at small scale points)
- `mix.lifetimeHolders` = 100 (Lifetime accounts (a fixed cohort: checkout no longer sells it). GUESS = the 100 intro seats; replace with README.md query 1)
- usage profiles and the plan mix (`profiles`, `mix`): all guesses
- Neon load: 40 CU-hours per 1,000 MAU above the floor (in model.mjs)
