# Orbit unit economics (model output)

Generated 2026-10-18 from `inputs.json`. Scenario: included AI **OFF (paused, BYOK only)**, Deepgram opt-out multiplier **2x**.
Every GUESS in inputs.json flows into these numbers. Treat them as orders of magnitude until the README queries replace the guesses.

## 1. Cost per user per month, by plan and usage profile

Deepgram per minute in this scenario: meeting $0.02, short-form $0.01.

| plan | profile | audio min | DB MB | speech | AI (Orbit key) | storage | hosting | email | total |
|---|---|---|---|---|---|---|---|---|---|
| free | light | 5 | 16 | $0.06 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.07** |
| free | typical | 18 | 49 | $0.23 | $0.00 | $0.02 | $0.01 | $0.01 | **$0.27** |
| free | heavy | 90 | 49 | $1.17 | $0.00 | $0.02 | $0.02 | $0.01 | **$1.23** |
| free | abusive | 690 | 49 | $9.00 | $0.00 | $0.02 | $0.09 | $0.03 | **$9.14** |
| pro | light | 24 | 16 | $0.31 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.33** |
| pro | typical | 216 | 86 | $3.46 | $0.00 | $0.04 | $0.01 | $0.01 | **$3.51** |
| pro | heavy | 960 | 376 | $15.11 | $0.00 | $0.16 | $0.02 | $0.01 | **$15.30** |
| pro | abusive | 1560 | 1872 | $26.17 | $0.00 | $0.77 | $0.09 | $0.03 | **$27.07** |
| max | light | 45 | 16 | $0.59 | $0.00 | $0.01 | $0.00 | $0.00 | **$0.60** |
| max | typical | 405 | 86 | $6.50 | $0.00 | $0.04 | $0.01 | $0.01 | **$6.54** |
| max | heavy | 1800 | 376 | $28.33 | $0.00 | $0.16 | $0.02 | $0.01 | **$28.52** |
| max | abusive | 2400 | 1872 | $39.40 | $0.00 | $0.77 | $0.09 | $0.03 | **$40.29** |

## 2. Revenue net of Stripe fees, and gross margin per paying user

| plan | profile | list/month | net of fees | cost | margin | margin % |
|---|---|---|---|---|---|---|
| pro | light | $8.99 | $7.99 | $0.33 | $7.67 | 96% |
| pro | typical | $8.99 | $7.99 | $3.51 | $4.48 | 56% |
| pro | heavy | $8.99 | $7.99 | $15.30 | -$7.31 | -91% |
| pro | abusive | $8.99 | $7.99 | $27.07 | -$19.07 | -239% |
| max | light | $19.99 | $18.03 | $0.60 | $17.43 | 97% |
| max | typical | $19.99 | $18.03 | $6.54 | $11.49 | 64% |
| max | heavy | $19.99 | $18.03 | $28.52 | -$10.49 | -58% |
| max | abusive | $19.99 | $18.03 | $40.29 | -$22.25 | -123% |

## 3. The Deepgram credit

A one-time $15,000 credit, of which the app lets itself spend $14,250 before every speech surface has fallen back (src/lib/speech-cost.ts). While it lasts, speech costs no cash; the margin below shows both sides of it.

| users | Deepgram / month | credit lasts |
|---|---|---|
| 100 | $88.78 | 160.5 mo |
| 1,000 | $888 | 16.1 mo |
| 10,000 | $8,878 | 1.6 mo |
| 50,000 | $44,389 | 0.3 mo |

## 4. Free users

| profile | cost/month |
|---|---|
| light | $0.07 |
| typical | $0.27 |
| heavy | $1.23 |
| abusive | $9.14 |

A Free user who uses every metered feature to its cap costs **$1.23/month**; the blended Free user costs $0.46.
A blended Pro subscriber contributes $4.23/month. Conversion needed for Pro to carry Free:
- maxed Free users: **22%** of signups must pay
- blended Free users: **10%** of signups must pay (before fixed costs)

## 5. Scale points

| users | DB size | platform/fixed | variable | total cost | cost/user | net revenue (subs) | monthly margin | margin % |
|---|---|---|---|---|---|---|---|---|
| 100 | 4.1 GB | $43.31 | $91.89 | $121 | $1.21 | $116 | -$5.43 | -5% |
| 1,000 | 40.6 GB | $85.22 | $919 | $984 | $0.98 | $1,160 | $176 | 15% |
| 10,000 | 406.1 GB | $254 | $9,189 | $9,423 | $0.94 | $11,599 | $2,176 | 19% |
| 50,000 | 2030.7 GB | $822 | $45,946 | $46,747 | $0.93 | $57,995 | $11,247 | 19% |

Speech is counted as a cost here even though the Deepgram credit pays for it at first: section 3 shows how long that lasts, and "while the credit lasts" margin is this one plus the speech column below.

### Variable spend by category

| users | speech (all) | of which meetings | AI (Orbit key) | DB storage | Blob | functions | email |
|---|---|---|---|---|---|---|---|
| 100 | $88.78 | $30.04 | $0.00 | $1.67 | $0.05 | $0.71 | $0.69 |
| 1,000 | $888 | $300 | $0.00 | $16.65 | $0.48 | $7.08 | $6.93 |
| 10,000 | $8,878 | $3,004 | $0.00 | $167 | $4.85 | $70.76 | $69.30 |
| 50,000 | $44,389 | $15,019 | $0.00 | $833 | $24.25 | $354 | $347 |

### Pricing cliffs by scale point

- **100 users**: DB ~4.1 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $1.42/month); Neon compute ~185 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Neon compute $19.56, Domains $1.83
- **1,000 users**: CDN requests ~3.8M/month: past the 1M included tier; Resend: Monday digest peak ~500 emails/day, past the Free plan's 100/day; DB ~40.6 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $14.21/month); Neon compute ~203 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~3.9 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $20.00, Neon compute $21.47, Resend $20.00, Domains $1.83
- **10,000 users**: CDN requests ~38.2M/month: past the 1M included tier; Resend: Monday digest peak ~5000 emails/day, past the Free plan's 100/day; DB ~406.1 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $142/month); Neon compute ~383 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~39.4 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $100, Neon compute $40.55, Resend $90.00, Domains $1.83
- **50,000 users**: CDN requests ~190.9M/month: past the 1M included tier; Resend: Monday digest peak ~25000 emails/day, past the Free plan's 100/day; Sentry: ~10,000 errors/month, past the free 5k (excess is dropped, not billed, until you upgrade); DB ~2030.7 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $711/month); Neon compute ~1183 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~197.1 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby); ~231 concurrent Deepgram streams at peak: past pay-as-you-go's 150-stream limit (new meetings fail to connect). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $300, Neon compute $125, Resend $347, Sentry $26.00, Domains $1.83

## 6. Break-even

Fixed platform cost at ~1,000 users: $85.22/month. Blended Pro contribution $4.23; with 7.3 Free users per subscriber, each subscriber nets $0.84.
**Break-even: ~102 paying subscribers** at this plan mix, counting speech at full price (fewer while the Deepgram credit pays for it).

## 7. Sensitivity (monthly margin at 1,000 and 10,000 users)

| change | 1k margin/mo | 1k vs base | 10k margin/mo | 10k vs base |
|---|---|---|---|---|
| baseline | $156 | - | $2,156 | - |
| Pro $6.99 | -$26.83 | -$183 | $330 | -$1,826 |
| Pro $11.99 | $430 | $274 | $4,894 | $2,739 |
| Max $24.99 | $247 | $91.30 | $3,068 | $913 |
| Free limit 250 contacts | $160 | $3.82 | $2,194 | $38.18 |
| Free limit 1,000 contacts | $149 | -$6.61 | $2,089 | -$66.12 |
| Free short-form 60 → 15 min | $360 | $204 | $4,200 | $2,044 |
| Pro speech 5h+5h → 3h+3h | $373 | $217 | $4,329 | $2,174 |
| Deepgram at list (no opt-out premium) | $551 | $396 | $6,113 | $3,957 |
| Included AI resumed (current allowances) | -$127 | -$283 | -$672 | -$2,828 |
| Included AI resumed, Free 50 → 10 credits | -$12.59 | -$168 | $472 | -$1,684 |
| Included AI resumed, Free 0, Pro 300 → 150 | $64.76 | -$91.00 | $1,246 | -$910 |
| Conversion +1 pt (free 88% → 87%, pro +1) | $203 | $46.91 | $2,625 | $469 |
| Heavy share 13% → 25% | -$213 | -$369 | -$1,731 | -$3,886 |
| Embeddings: drop the duplicate jsonb copy | $166 | $10.43 | $2,260 | $104 |

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
- usage profiles and the plan mix (`profiles`, `mix`): all guesses
- Neon load: 40 CU-hours per 1,000 MAU above the floor (in model.mjs)
