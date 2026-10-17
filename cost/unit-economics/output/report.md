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

## 3. The Deepgram credit

A one-time $15,000 credit, of which the app lets itself spend $14,250 before every speech surface has fallen back (src/lib/speech-cost.ts). While it lasts, speech costs no cash; the margin below shows both sides of it.

| users | Deepgram / month | credit lasts |
|---|---|---|
| 100 | $63.21 | 225.4 mo |
| 1,000 | $632 | 22.5 mo |
| 10,000 | $6,321 | 2.3 mo |
| 50,000 | $31,605 | 0.5 mo |

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
| 100 | 4.1 GB | $43.31 | $66.33 | $99.69 | $1.00 | $116 | $16.30 | 14% |
| 1,000 | 40.6 GB | $85.22 | $663 | $728 | $0.73 | $1,160 | $431 | 37% |
| 10,000 | 406.1 GB | $254 | $6,633 | $6,867 | $0.69 | $11,599 | $4,732 | 41% |
| 50,000 | 2030.7 GB | $822 | $33,163 | $33,964 | $0.68 | $57,995 | $24,031 | 41% |

Speech is counted as a cost here even though the Deepgram credit pays for it at first: section 3 shows how long that lasts, and "while the credit lasts" margin is this one plus the speech column below.

### Variable spend by category

| users | speech (all) | of which meetings | AI (Orbit key) | DB storage | Blob | functions | email |
|---|---|---|---|---|---|---|---|
| 100 | $63.21 | $20.08 | $0.00 | $1.67 | $0.05 | $0.71 | $0.69 |
| 1,000 | $632 | $201 | $0.00 | $16.65 | $0.48 | $7.08 | $6.93 |
| 10,000 | $6,321 | $2,008 | $0.00 | $167 | $4.85 | $70.76 | $69.30 |
| 50,000 | $31,605 | $10,041 | $0.00 | $833 | $24.25 | $354 | $347 |

### Pricing cliffs by scale point

- **100 users**: DB ~4.1 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $1.42/month); Neon compute ~185 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Neon compute $19.56, Domains $1.83
- **1,000 users**: CDN requests ~3.8M/month: past the 1M included tier; Resend: Monday digest peak ~500 emails/day, past the Free plan's 100/day; DB ~40.6 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $14.21/month); Neon compute ~203 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~3.9 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $20.00, Neon compute $21.47, Resend $20.00, Domains $1.83
- **10,000 users**: CDN requests ~38.2M/month: past the 1M included tier; Resend: Monday digest peak ~5000 emails/day, past the Free plan's 100/day; DB ~406.1 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $142/month); Neon compute ~383 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~39.4 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $100, Neon compute $40.55, Resend $90.00, Domains $1.83
- **50,000 users**: CDN requests ~190.9M/month: past the 1M included tier; Resend: Monday digest peak ~25000 emails/day, past the Free plan's 100/day; Sentry: ~10,000 errors/month, past the free 5k (excess is dropped, not billed, until you upgrade); DB ~2030.7 GB: past Neon Free's 1 GB/project (writes fail there; Launch bills $711/month); Neon compute ~1183 CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there); Blob ~197.1 GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby); ~155 concurrent Deepgram streams at peak: past pay-as-you-go's 150-stream limit (new meetings fail to connect). Platform lines: Vercel Pro platform $20.00, Vercel cron baseline $1.92, Vercel Flat Rate CDN tier $300, Neon compute $125, Resend $347, Sentry $26.00, Domains $1.83

## 6. Break-even

Fixed platform cost at ~1,000 users: $85.22/month. Blended Pro contribution $5.53; with 7.3 Free users per subscriber, each subscriber nets $2.83.
**Break-even: ~31 paying subscribers** at this plan mix, counting speech at full price (fewer while the Deepgram credit pays for it).

## 7. Sensitivity (monthly margin at 1,000 and 10,000 users)

| change | 1k margin/mo | 1k vs base | 10k margin/mo | 10k vs base |
|---|---|---|---|---|
| baseline | $411 | - | $4,712 | - |
| Pro $6.99 | $229 | -$183 | $2,886 | -$1,826 |
| Pro $11.99 | $685 | $274 | $7,451 | $2,739 |
| Max $24.99 | $503 | $91.30 | $5,625 | $913 |
| Free limit 250 contacts | $415 | $3.82 | $4,750 | $38.18 |
| Free limit 1,000 contacts | $405 | -$6.61 | $4,646 | -$66.12 |
| Free short-form 60 → 15 min | $534 | $123 | $5,939 | $1,226 |
| Pro speech 5h+5h → 3h+3h | $498 | $86.95 | $5,582 | $870 |
| Deepgram at list (no opt-out premium) | $694 | $282 | $7,535 | $2,823 |
| Included AI resumed (current allowances) | $129 | -$283 | $1,885 | -$2,828 |
| Included AI resumed, Free 50 → 10 credits | $243 | -$168 | $3,029 | -$1,684 |
| Included AI resumed, Free 0, Pro 300 → 150 | $320 | -$91.00 | $3,802 | -$910 |
| Conversion +1 pt (free 88% → 87%, pro +1) | $470 | $59.02 | $5,302 | $590 |
| Heavy share 13% → 25% | $171 | -$241 | $2,106 | -$2,606 |
| Embeddings: drop the duplicate jsonb copy | $422 | $10.43 | $4,816 | $104 |

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
