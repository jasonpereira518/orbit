# Launch readiness — changelog, Sep 17 2026

What the six phase plans in `docs/superpowers/plans/2026-09-15-launch-*` changed, how each change was checked, what is still open, and what turned up along the way. It answers `docs/production-readiness-audit-2026-09-15.md`. Everything is on PR #201 (`claude/launch-p4`): 126 commits, one per task. Each commit message carries that task's own verification notes, and this page summarises them.

**Verdict.** The code half of the plan is done. **Orbit is not launch-ready until the manual steps below are done and the acceptance run passes.** Most of the remaining risk is configuration nobody can set from the repo: backup secrets, the Stripe portal, Clerk consent, Google verification and the legal read. The code now reports each of those gaps loudly instead of failing silently, but it cannot close them.

**State of the branch.**

| Check | Result |
|---|---|
| Smoke suite | 273 of 273 pass (PGlite; provider keys stripped) |
| Playwright | 5 core flows pass; 1 skipped (Lifetime → Stripe Checkout, which needs test-mode keys) |
| Typecheck | Clean |
| Lint | 0 errors |
| Toast copy | The house-voice guard passes |
| Build | `next build` passes |
| CI on #201 | 6 of 6 green |
| Merge state | `main` merged three times, most recently #203 and #205–#212. The branch conflicts with nothing |

**Schema.** `SCHEMA_VERSION = 65`. The stack claimed 58, 59 and 60. 64 merged `main`'s 61 and 62. 65 is Phase 4's data-only migration. 57 and 63 were skipped because unpushed worktrees had claimed them; see the new findings.

---

## What changed, and how it was checked

"Browser" below means headless Chrome over CDP on a throwaway demo database. The in-app pane is 0×0 and passes checks vacuously, so it was not used for sign-off.

### Phase 0 — stop the bleeding

| Change | How it was checked |
|---|---|
| Caught errors reach Sentry with a short reference the user can quote (`reportError`, ~100 catch sites) | Smokes. Inventory in `docs/error-reporting-2026-09-15.md` |
| A `user.deleted` webhook now deletes the settings row: keys, email, Stripe customer id | Purge smoke |
| A full refund or a lost dispute withdraws Lifetime or Pro. Partial refunds and won disputes change nothing | Pure decision smoke, plus a webhook smoke through the real apply path |
| Invented sample prospects can never be sent to (example.com, blocked on both send paths) | Smoke |
| The bulk-send preview is scoped to the campaign's own messages. Before, a leaked message id read another user's draft | Smoke |
| A rollback keeps health green: an "ahead" database answers 200 `degraded`, and the version is never lowered | A local database stamped at a newer version was booted against this build |
| The backup workflow fails loudly, uses a pg_dump that matches Postgres 18, and pages on failure | The step bodies ran in ubuntu:24.04 against a disposable PG18: guards, pinned install, pipefail, dump → decrypt → restore of 250 rows |
| Recruiter contact details are no longer readable through anyone's link | Smokes. Phase 2 replaced this with per-link details |
| Provider errors are translated in streaming chat, transcription and embeddings. A bare `AbortError` reads as a timeout | `/chat` streamed a full answer through the wrapped path |
| A new AI key gets one cheap validation call before it is saved | Fake keys refused by all three real providers. A real Gemini key accepted in ~150 ms. Inline error checked in the browser at 1280 and 375 px |
| The invalid `claude-opus-4` preset is now `claude-opus-4-5`. Temperature is sent only to models that accept it | Checked against Anthropic's docs. **Not run live** (no Anthropic key) |
| Outreach replies go to the sender, not Orbit's inbox | Checked on the wire against a local Resend stand-in |
| Resend rejections on Orbit's key are recorded and alerted | Smoke against a stand-in answering Resend's 403 |
| Signed-out `/api/*` calls get a JSON 401. Before, the meeting recorder read the sign-in page as a 200 and deleted audio chunks | Clerk test instance: signed-out POSTs get 401, and pages still redirect |
| The admin can delete an account with no email | Smoke. **The dialog was not opened**: it needs a signed-in operator |
| Dev no longer prints Server Function arguments, which included saved API keys | `next dev` log checked |

### Phase 1 — say true things

| Change | How it was checked |
|---|---|
| The privacy policy is rewritten to match the code: per-scope Google disclosures generated from the code, the Limited Use statement verbatim, processors, operator access | A pure smoke fails when a disclosed scope, a processor or a corrected claim drifts. **Needs a legal read (D4)** |
| Terms: billing via Stripe, refunds end access, self-serve deletion | Browser |
| The admin console never shows capture text, transcripts, photos or any `*_encrypted` column | A schema-walking smoke fails on any new encrypted column |
| Every admin contact view is logged by id. A sign-in link needs a reason | Smoke |
| Google asks for one scope per purpose, with incremental consent, and stores only what was granted | Browser for the missing-scope and cancelled copy. **The Google consent screen was not exercised**: it needs real OAuth credentials |
| Calendar sync and confirmation emails have their own consent | Browser |
| Terms acceptance is recorded with its version, at sign-up, in guided setup, and from an app-shell notice for existing accounts | Browser: checkbox gate, notice on every page, Accept persists across reload, 375 px |
| Self-serve account deletion cancels Stripe first, then purges, then deletes the Clerk user | Smoke across six paths. The typed-confirmation gate was checked in the browser. **The destructive confirm was not pressed** |
| The LinkedIn timeline backfill is opt-in, with an up-front cost estimate and a cap of 300 conversations a day. Single-message threads make no AI call | Smokes. Estimate, toggle and reload checked in the browser |
| A 30-day AI usage and cost card in Settings | Browser against real calls |
| `/knowledge` reads a bounded, projected query | Page-budget smoke. Browser shows the same stats |

### Phase 2 — money and deletes

| Change | How it was checked |
|---|---|
| Stripe webhook dedupe by event id. Bookings are written before the mirror, so a failed booking retries cleanly | Smokes |
| An out-of-order subscription event is ignored (per-account clock) | Smoke |
| The checkout is verified on return, so a paid user is never stuck on free if the webhook is late | Smoke. **Not run against real Stripe** |
| A purge is a resumable ledger: an interrupted deletion finishes nightly, and one that gives up raises `purge.stuck` (critical) | Smoke that breaks a real purge mid-way |
| The delete dialog says what was deleted and what is still pending | Smoke |
| Accounts whose Clerk user is gone are swept, with a guard against a wrong-instance key | Smoke |
| Google grants are revoked on disconnect and on purge | Smoke. **Not exercised against Google** |
| The disconnect dialog explains the consequences and offers to delete imported data | Pure smoke. **Not opened in the browser**: it needs a connected account |
| Avatar blobs have unguessable names and are deleted on replace, merge and purge | Smokes |
| Deleting a contact removes the structured rows tied to it | Browser at 1280 and 375 px |
| Recruiter contact details live on each user's own link. The shared row takes them only from someone who shares | Smokes, including the one-time backfill run the way it really runs |
| The data export is built from the deletion registry and streamed from `/api/export` | Against the dev server: 200, 216 KB, 16 categories, no secret columns |
| Subscribers can cancel and manage billing through Stripe's portal | Smoke. **Needs the portal configured in Stripe** (manual steps) |

### Phase 3a — integrations and AI reliability

| Change | How it was checked |
|---|---|
| A token refresh no longer resets sync state. Consent-type refresh errors read as "reconnect" | Smokes |
| Every Google call goes through the retry wrapper. A mid-scan 401 no longer advances the watermark | Smokes |
| "Out of credit" is distinct from "going too fast" | Classifier smoke |
| The recruiter scan stops on a key problem instead of skipping the mailbox | Smoke |
| Connection cards say "Session expired" or "Calendar sync paused", and the bell alerts | Browser on all three seeded states |
| Eventbrite connect outcomes are shown | Browser. curl confirmed the state cookie is expired |
| Meeting uploads stop on a dead key. Streaming chat aborts on disconnect and records `cancelled` | Smokes. **The Vercel abort check is a manual step** |
| Embedding batches are capped by tokens, and poison rows are bisected out (`embedding_failures`, v60) | Smokes |
| Chat says when it fell back to keywords. Per-key Clear. Rejected Wispr keys are surfaced | Smokes. Clear checked in the browser |
| Budgets for Unavatar, Microlink and hosted Apollo. A per-IP contact-form limit in Postgres | Smokes |
| Twilio STOP reads as opted out. BYOK Resend sends from the user's verified domain | Smokes |

### Phase 3b — ops and scale

| Change | How it was checked |
|---|---|
| Alert state is persisted before Slack is tried | Smoke |
| Eleven new conditions plus shared-budget exhaustion, each with a runbook row | Condition and loader smokes |
| Env contract: every variable the code reads is documented. Stale docs fixed, with doc guards | Guards |
| `linkedin_slug` is rewritten only when its expression changed | Smoke |
| A DDL fingerprint is stored beside the version | Smoke |
| `drizzle-kit push` refuses without consent or against production | The real CLI refuses before connecting |
| Runtime migration-lease wait capped at 20 s | Smoke |
| Connector sync runs 4 lanes and 20 per run, with a lag metric | Smoke |
| `/admin` aggregates memoised for 10 min | Smoke |
| Internal self-kicks time out after 10 s | Smoke |
| A wrong health token gets a 401 | Smoke |
| One scheduler (GitHub Actions). Backup heartbeat. 60-day runbook | Workflow reviewed. **Not run on GitHub** |
| Playwright suite with a local Gemini stub, five flows, CI job | Green locally and in CI |

### Phase 4 — polish

| Change | How it was checked |
|---|---|
| Capture quotes only skipped date phrases that are in the note. The audit's "hallucinated phrase" was a hard-coded constant | Smoke and browser |
| A dated commitment supersedes the default-window reminder for the same follow-up | Smoke |
| The Save button counts every reminder the save writes, and `main`'s opportunities | A PGlite smoke proves planned = written. Browser shows "Save 3 contacts + 2 reminders" |
| Same-day interactions read "today", not "in about 9 hours" | Fixed-clock smoke and browser |
| Name matches rank first in pickers, hybrid search and the contacts page, including `main`'s relevance sort and paging | Smokes. Browser: "Priya" gives Priya Nair before Hassan Ali on `/contacts` and ⌘K |
| 44 px touch targets on phones | Browser at 375 px with touch emulation |
| Every icon-only button has an accessible name, guarded by a smoke | Accessibility tree: nine named tabs, plus combobox "Provider" and "Model" |
| README: local configurations and traps. The demo sign-in script names the exact provisioning command | Smoke |
| The localhost plan card says "Demo account — plan limits lifted on localhost" | Browser |
| The recruiter sharing panel says what is shared | Browser, private and shared states |
| No plaintext IPs or model output in logs | Smoke |
| A capture save no longer merges into a duplicate the person declined | Smoke. The retried-save merge still works |
| The daily cron sweeps abandoned meeting transcripts and expired scan grants | Smoke |
| **The calendar feed token is stored as a SHA-256 and shown once** | Browser: once-only link, `.ics` 200, reload shows no link, regenerate gives 200 new and 404 old |
| Model-inferred timeline events are `ai_derived` and excluded from closeness and last touch | Smokes |
| v65 migration: existing feed tokens hashed in place, `li-event` rows retagged | Run twice on a seeded database: token hashed, still resolves, never double-hashed |
| `db:setup` exits after success. It used to hang | Run |

---

## What is still open

### Manual steps — must be done by a person

Collected from every phase plan. The PR description lists fewer. **Bold** items block launch.

**Before the first external user**

1. **Backup secrets (M1)** — `BACKUP_AGE_PUBLIC_KEY` and `DATABASE_URL` (the direct host, not `-pooler`) in GitHub Actions. Run the workflow once and confirm it goes green. **Every backup to date has failed.**
2. **Restore drill (M2)** — restore the newest artifact into a Neon branch and log it in `docs/RUNBOOK.md` (R1).
3. **Sender domain (M3)** — verify the Orbit domain in Resend and set `RESEND_FROM_EMAIL` to an address on it. It was a gmail.com address, and every waitlist welcome was rejected.
4. **Production variables** — `SLACK_OPS_WEBHOOK_URL`, `SLACK_OPS_CRITICAL_WEBHOOK_URL`, `SENTRY_DSN`, `BETTERSTACK_HEARTBEAT_URL`, `RESEND_WEBHOOK_SECRET` and the Google variables. `config.alerts_undeliverable` fires until Slack is set.
5. **Neon statement timeout** — `ALTER ROLE <app role> SET statement_timeout = '20s'`.
6. **Clerk** — confirm `user.deleted` is enabled on the webhook (M7), and turn on **Require express consent** under Legal (M9).

**Before anyone pays**

7. **Vercel Pro (D1 / M5)** — Hobby forbids commercial use.
8. **Stripe customer portal** — configure it in both test and live mode. Without a saved configuration, **Manage billing** shows the unavailable copy for every subscriber. *This step is missing from the PR description.*
9. **Stripe webhooks (M6)** — confirm `charge.refunded` and `charge.dispute.closed` are subscribed.
10. **Stripe business name** — set it to `Orbit` in live and sandbox mode. The sandbox shows "stripe-almond-grass".
11. **Legal read (D4)** — `/privacy` and `/terms`. `TERMS_VERSION` moved to 2026-09-16 in the merge, so existing users will be asked to accept again.

**Before opening sign-up publicly**

12. **Google OAuth verification (M10)** — submit once the consent screen matches the per-purpose scopes.
13. **Twilio** — enable Advanced Opt-Out on the sending number (D6).
14. **Better Stack** — a backup heartbeat (1 day, 12 h grace). If the health monitor's URL carries `?token=`, open it once: a 401 means the token is wrong and was passing silently before.

**After deploy**

15. Vercel → Cron Jobs lists nothing, and GitHub Actions `ops` shows the hourly backstop.
16. Close a `/chat` tab mid-answer and confirm a `cancelled` usage row.
17. Refresh your own subscribed Orbit calendar and confirm it still updates. Tell beta users that the feed link is shown only once.
18. Watch the first deploy's `db:migrate` print `schema version 65 applied` once.
19. **Do not promote a deployment older than this PR afterwards.** It would 404 every calendar feed (the tokens are hashed).
20. After a week of `csp.report` rows, decide on `CSP_ENFORCE=1` (M4).
21. After three green PRs, make the Playwright job a required check on `main`.
22. Add a 45-day reminder to check for disabled scheduled workflows.
23. Put `PRODUCTION_DB_HOST` in the main checkout's `.env.local` so the drizzle guard can tell production apart.

**Local, once**

24. Run `npm run test:e2e` with test-mode Stripe keys, so the Checkout flow actually runs.
25. Provision the demo account in the Clerk test instance.
26. VoiceOver pass on `/settings?integration=ai`.
27. Real iPhone and Android taps next to the row icons.

### The acceptance run

The roadmap's 14-step acceptance run (a preview on its own Neon branch, with Clerk and Stripe in test mode) **has not been done**. It is where the "not exercised" items above get their first real test:

- sign-up and terms;
- session expiry in chat;
- key refusal per provider;
- Google consent and revocation;
- the Stripe late-webhook, portal-cancel and refund sequence;
- the zero-rows proof after account deletion;
- 10k-contact timings;
- rollback;
- restore;
- phones;
- the authz re-sweep.

### Readiness criteria

| # | Criterion | State |
|---|---|---|
| R1 | Backups and a restore drill | Code done. **Blocked on M1 and M2** |
| R2 | Deletion leaves zero rows | Code done. Proof is acceptance step 9 |
| R3 | Policy matches code, plus a legal read | Text done. **Blocked on D4 and M10** |
| R4 | Money correct in every order | Code and smokes done. Acceptance step 7 against real Stripe |
| R5 | No cross-tenant access | Known holes fixed. Acceptance step 14 re-sweep pending |
| R6 | AI spend capped and visible | Done |
| R7 | Every known failure reaches a person | Code done. **Blocked on Slack and Sentry variables** |
| R8 | Boring rollback | Code done. Acceptance step 11. Note the calendar-token caveat |
| R9 | Five flows on every PR | Green in CI. Making it a required check is a manual step |
| R10 | Vercel Pro | **Blocked on D1** |
| R11 | Self-serve cancel | Code done. **Blocked on the portal configuration** |

---

## New findings — not in the audit

Found while doing the work. Most were fixed in the commit named.

**Fixed**

- `isMissingAiApiKeyError` matched Stripe's "Invalid API Key provided", telling buyers to add an AI key. Every Luma failure also claimed the key was wrong (`0a8e4cfc`).
- The backup had a second, hidden cause: Ubuntu's pg_dump 16 aborts against Postgres 18. Setting the secrets alone would never have produced a dump (`b6e5cda1`).
- A bare `AbortError` from `aiSignal` read as "couldn't answer" and was counted as `other` (`890d9a12`).
- `@vercel/blob` 2.8 refuses to overwrite, so a contact's second photo already threw (`42438a87`).
- `getValidAccessToken` rewrapped `ReauthRequiredError` as a plain `Error`, so the scheduler re-armed connections it had just parked (`24644e3c`).
- An import cycle made `import-job-dispatch` throw "Cannot access … before initialization" depending on import order (`e7bee3a4`).
- Dev logged Server Function arguments, including saved API keys (`c6da15d9`).
- The audit's "hallucinated date phrase" was a hard-coded "in a fortnight", not model output (`a7870039`).
- The profile page counted model-inferred events toward its closeness fallback and frequency label, disagreeing with the cohort builder (`e1cfae49`).
- `db:setup` never exited after success (`0bf5d2b8`).
- Smoke hygiene: several new smokes left rows in the shared smoke PGlite, which is what made `smoke-admin-analytics` fail mid-suite. They all clean up now.
- The Playwright capture flow could never pass as planned: `fill()` landed before React hydrated. Fixed with retry-until-effect helpers (`0f89d0c8`).

**Process**

- **SCHEMA_VERSION collisions come from unpushed worktrees, not only branches.** 57 (the AI-gating worktree) and 63 (`onboarding-flow-revision`, `silly-gagarin`) were claimed locally. A remote-only scan would have reused both. Scan `git worktree list` too.
- The Phase 2 schema commit landed without its Drizzle declarations: an edit raised before writing, so the columns existed but Drizzle could not see them. Fixed in `069a0351`. Re-check files after any scripted edit that errors.
- One PGlite database was corrupted by running a writing script while that worktree's dev server held it. The repo guard quarantined it (`.data/pglite-corrupt-2026-09-16T…`, still on disk, safe to delete). Browser checks since then used a throwaway `ORBIT_PGLITE_DIR`.
- A real Gemini key in a worktree's `.env.local` was reaching the smoke suite. Fixed on `main` by #197.

**Not fixed — decide**

- **A private recruiter list still writes to the shared directory.** Logging a recruiter who already exists fills that row's missing firm and adds specialties, even when the user does not share. It is not contact PII, but it is the user's activity leaking into the pool. The panel copy was narrowed to promise only what is true. If it should not happen, `mergeRecruiterFields` needs the same sharing gate that contact details have.
- **The calendar feed link is shown once.** This is by design, but existing users will not find their link in Settings after deploy and must regenerate. Worth a line in release notes.

---

## Low-confidence items — look here first if something breaks

1. **The first `main` merge (#195 AI gate) rewrote how errors are classified.**
   - `isMissingAiApiKeyError` now combines Phase 0's narrowing with a `KEY_REMEDY_DENIALS` set.
   - `translatingProviderErrors` wraps calls inside `withRateLimitBackoff`.
   - Wispr goes through a new `transcribeWithWisprOutcomeGrant`.

   The smokes (including the source guard) pass, but no real provider traffic has gone through the merged path. Test a refused key and an out-of-credit key per provider on the preview.
2. **The legal pages were reconciled by hand.** Phase 1's text and #195's managed-AI facts were merged. A sentence that claimed every call runs on the user's key was replaced with #195's per-plan list. A human should read both pages end to end.
3. **`confirmCheckoutSession` now runs Phase 2's verification first, then #195's Lifetime confirmation.** It has not been run against Stripe. Acceptance step 7 covers it.
4. **Search ranking.** The name tier now leads `main`'s relevance ordering too. A literal-only name match can outrank a strong semantic match, which is intended, but watch for complaints.
5. **The Anthropic temperature allowlist** is based on the docs, not a live call.
6. **The migration-lease cap (20 s) and serve-without-sweeping** have only been exercised in smokes, not under a real concurrent deploy.
7. **Google, Microsoft and Stripe side effects** (revoke, portal, consent screens) have been checked only against stubs. The acceptance run is their first real test.
