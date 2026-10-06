# Meeting notes → reminders → opportunities

**Date:** 2026-09-17
**Status:** Built, all 13 phases merged. Two things are unverified and one is blocked —
see "What still needs a human". The job feed has never fetched anything in production.

Written after the fact. The plan asked for this spec up front and it did not get written;
phases 0–12 shipped without it. So this is a record of decisions already made rather than
a proposal, and it is honest about which of them have never been exercised against real
data.

## Problem

Capture already had a strong spine — `/capture` ingests text, voice, photos, `.ics` and
`.eml`; `parseBulkCaptureNotes` extracts people; `saveNoteBatch` writes contacts,
interactions, action items, mentions and reminders in one idempotent pass. What it did not
have was the layer that turns a meeting into leverage:

1. `contacts.opportunities` was a `jsonb string[]` with **zero UI** — nothing to type,
   filter or hang a reminder off.
2. Only an explicitly dated commitment became a reminder. An implied next step did not.
3. "Ping me monthly" produced nothing; dormancy used a hardcoded 30 days.
4. Nothing was triggered by the outside world.
5. `@`-mentions existed only in the chat composer.
6. A folder of meeting notes collapsed into one timeline entry.

## How it works

```
drop a folder ─► file-drop.ts (webkitGetAsEntry, batched readEntries)
  ─► notes-sorter-dialog (tray on top, bins below; one bin = one note)
  ─► prepare-upload.ts (PDF → JPEG pages, per-note page budget)
  ─► use-capture-fanout (concurrency 2, 429 → waiting → retry)
  ─► POST /api/capture/jobs?autoQueue ─► runCaptureParse
      ─► typed opportunities, implied next steps, cadence phrases
  ─► review (opportunity chips, implied reminders unticked below the bar)
  ─► confirmBulkCapture ─► saveNoteBatch
      ─► contact_opportunities ─► syncContactOpportunityMirror
      ─► reminders (origin: explicit | implied)
      ─► contacts.cadence_days

hourly ─► /api/jobs/feed/sweep ─► conditional GET of SimplifyJobs listings.json
  ─► ingestListings ─► matchJobPostings (driven from open opportunities)
  ─► job_posting_matches ─► one ai_suggestion per (user, contact) per run
  ─► notification bell at urgency "info", linking to /contacts/{id}
  ─► ContactJobMatchesSection on the profile
```

## Decisions worth keeping

**The jsonb column became a derived mirror with exactly one writer.**
`syncContactOpportunityMirror` is the only thing that writes `contacts.opportunities`. This
was not tidiness: `note-batch-save.ts` passed `opportunities: parsed.opportunities` on the
*merge* branch and `updateContactForUser` overwrote the column outright, so a second note
about the same person silently deleted the first note's opportunities. The typed table had
to fix that bug, not preserve it, and a single writer fixes it by construction while
keeping four existing readers working.

**No `pgEnum`, one schema bump.** Kinds and statuses are `text` columns plus `as const
satisfies` arrays, matching `interaction-types.ts`. Unknown values degrade to a generic
label rather than throw — an enum widened in one deploy must not blank a row rendered by an
older client. Everything rode a single `SCHEMA_VERSION` bump. The plan predicted 56 and it
was not 56 by the time it landed — the changelog block in `src/db/index.ts` records six
branches that had already collided on a number, and more landed while this was in flight.
Re-check before claiming one; the column is at 62 today.

**Implied steps are marked by `reminders.origin`, not by a new `reminder_type`.** That
column already encodes *date provenance* (`manual` / `extracted_date` / `ai_suggested`) and
is read by `TYPE_LABELS` and the step-4 collision rule. Nor are implied items scored 59 to
slip under the existing `confidenceScore >= 60` gate — that couples two unrelated meanings,
and a later confidence tweak would silently start pre-ticking inferences. They get their own
`IMPLIED_AUTO_TICK_CONFIDENCE`, which is 0.8 on the model's 0–1 scale and deliberately not
the same number as the reminder gate's 60 on a 0–100 one.

**Cadence is days, and it is not the `cadence` in `closeness.ts`.** Same word, different
noun: that one is a touch-*count* score component. The next occurrence is rolled forward by
whole periods until it is ≥ today, so a three-month-old note saying "monthly" schedules the
next check-in rather than one already overdue.

**`post_event` is deliberately NOT cadence-gated.** It fires on the *first* interaction,
before any cadence is agreed; gating it would suppress exactly the nudge that turns a
one-off meeting into a relationship. `linkedin_thread_quiet` is gated on its lower bound
only — the upper bound stops ancient threads resurfacing and has nothing to do with an
agreed cadence.

**The matcher is driven from the opportunity side.** Open internship/referral opportunities
number in the tens to low hundreds globally; `job_postings` is the largest table in the
database. Iterating postings would need a new global index to answer a question the small
table answers in one query.

**A match is an `ai_suggestion`, never a reminder.** `loadNotificationPanel` maps
suggestions at a hardcoded `urgency: "info"`, so "an unconfirmed guess never fires an OS
notification" holds structurally with no edits to that file. The reason is stronger here
than for the suggestions that rule was written for: this text came from an anonymous pull
request to a public repository, so firing an OS notification off it would be a
content-injection channel into the operating system's own UI.

**One bin is one request, so the page budget is per note.** `MAX_SCAN_PAGES` bounds a single
upload. Spending it per *drop* — which `sortAndNormalizeScanFiles` did — meant three PDFs
read the first few pages of the first one and none of the other two.

**A note is sized by what it will weigh once prepared.** Five 5MB whiteboard photos total
25MB on disk and re-encode to about 6MB; a 2MB PDF becomes a dozen pages weighing far more.
Checking the size on disk refused the first and waved through the second.

## Bugs found in existing code along the way

- **`contacts.opportunities` was being overwritten on merge** — described above. Pre-existing,
  and the strongest argument for the mirror.
- **`confirmBulkCapture` trusted a client-supplied `contactId`**, inserting into
  `interaction_mentions` with no ownership check. Closed with an ownership filter in
  `note-batch-save.ts`.
- **`queueCaptureJob` discarded every other in-flight job**, making a capture queue
  impossible. Gated on `!batchGroupId`.
- **A dropped empty folder was staged as a zero-byte note** — `if (!out.length && ...)` should
  have been `if (!items.length && ...)`. Found by a new test.
- **The Notes library could not read a PDF at all.** Its picker offered them and the server
  rejects `application/pdf` by name. Fixed in #209.
- **Two backfills imported the smoke preamble**, which deletes `DATABASE_URL`, so they ran
  against an empty PGlite and reported zero rows — indistinguishable from "already done", in
  front of a data-loss window. Fixed in #206.
- **`ops.yml` has never run a single scheduled step.** Unrelated to this work but found by it;
  see below.

## Not done, on purpose

Per the plan's "what to cut" list, in the order it gave: per-user job-signal settings
(`job_feed_sources.enabled` is the only switch), posting retention pruning, multi-source
iteration. No `/opportunities` page and no new nav entry — opportunities live on the contact
profile only. No browsable job board.

## Verification

Automated, all green on `main`:

- `npm run typecheck`, `npm run lint` (0 errors), `npm test` — **198/198**.
- `npm run db:check` green at the current `SCHEMA_VERSION` (62).
- `npm run perf:pages` after the contact page gained two sections.
- New smoke scripts: `smoke-opportunity-taxonomy`, `smoke-opportunity-extract`,
  `smoke-implied-steps`, `smoke-cadence`, `smoke-capture-file-date`, `smoke-capture-fanout`,
  `smoke-mention-picks`, `smoke-job-feed-parse`, `smoke-job-company-match`,
  `smoke-job-feed-fetch`, `smoke-opportunities`, `smoke-capture-queue`,
  `smoke-job-feed-sweep`, `smoke-contact-job-matches`.

PDF rasterizing was verified once out-of-band, by shimming `@napi-rs/canvas` and running a
hand-built 20-page PDF through `rasterizePdf`: 12 pages out, 8 reported dropped, real JPEGs
at 1545×1999, and three pages producing three *different* images. That harness is not
committed — it needed three ES2025 polyfills to run the browser-targeted pdfjs build under
Node, which is what pdfjs means by "use the legacy build in Node.js environments".

## What still needs a human

1. **Set the Actions secrets.** The repository has none (`total_count: 0`), so `APP_URL` is
   empty, the `ops.yml` health probe cannot connect, and every gated step skips. **The
   job-feed sweep has therefore never run in production**, which means
   `ContactJobMatchesSection` will always be empty and no job signal has ever reached
   anyone's bell. `CRON_SECRET` and `SLACK_OPS_CRITICAL_WEBHOOK_URL` are also unset.

2. **Run the opportunities backfill**, once, against the real database:

   ```
   npx tsx scripts/backfill-opportunities.ts --dry   # prints the target, changes nothing
   npx tsx scripts/backfill-opportunities.ts         # idempotent, safe while the app is up
   ```

   It refuses to run without `DATABASE_URL` rather than reporting a false zero.

3. **The click-through**, which nothing automated covers. `npm run dev`, needs an AI key:

   - Drop 3 meeting-note files on `/capture?mode=library` → three jobs, three dates, three
     timeline entries on the right people. Include a PDF and a folder among them.
   - In one note type `@` and pick an existing contact → the link lands on both profiles
     with `matched_by = 'user_pick'`.
   - Confirm a batch → the profile shows typed opportunities, the brief's `next_step` names
     a real open commitment, and implied reminders appear unticked below the bar.
   - Seed a contact at a company in the feed with an open Internship opportunity, then
     `curl -H "Authorization: Bearer $CRON_SECRET" -X POST localhost:3000/api/jobs/feed/sweep`
     → one suggestion in the bell at `urgency: "info"`, a "Roles that opened" section on the
     profile, and a second run creating nothing. **Blocked on (1) for the deployed path**,
     though it works locally with a `CRON_SECRET` in `.env.local`.
