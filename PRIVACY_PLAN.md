# Orbit privacy plan

| | |
|---|---|
| Date | 2026-10-17; Phase 1 implemented 2026-10-18 |
| Inputs | [`PRIVACY_AUDIT.md`](PRIVACY_AUDIT.md): finding ids F-xx and mismatch ids M-xx |
| Status | Approved. Phase 1 implemented (see below); Phases 2–4 not started. Not legal advice. ⚖️ marks a decision that needs a lawyer. All policy text in §7 is a **DRAFT for counsel's review**, not final language. |

## Phase 1 status (2026-10-18)

| Item | Status | What shipped | Test |
|---|---|---|---|
| 1.1 Cancel billing on every deletion path | **Done** | New purge step `account`, run whenever the account itself closes, so it covers the Clerk webhook, admin hard-delete, orphan sweep and Settings. Failed cancels go to `billing_cancellation_queue` (schema v175), are retried hourly, and raise `billing.cancel_stuck`. | `smoke-account-closure` |
| 1.2 Global tables on account deletion | **Done**, except the audit-log email | The waitlist row, poll votes and broadcast log are removed by email. The audit-log email is kept and now disclosed (the ⚖️ choice defaulted to "disclose"). | `smoke-account-closure` |
| 1.3 Undo merge resurrection | **Done** | Derived rows are no longer archived. Unmerge restores the person's own data only. Purges strip archive copies. 30-day undo window, after which the archive's copy is cleared and the id alias kept. | `smoke-unmerge-after-purge` |
| 1.4 Contact delete references | **Done** | Ids removed from 5 tables. Group-note passages are dropped for rebuild. Hourly orphan-passage prune. Dialog copy updated (it already disclosed that free text stays). | `smoke-contact-delete-references` |
| 1.5 Import revert/undo leftovers | **Done** | Revert deletes through `deleteContactsForUser` and removes passages. Revert and undo clear removed people's raw rows. | `smoke-contact-delete-references` |
| 1.6 Error tooling | **Done**; Sentry dashboard settings **U** | `db-error-redact` is applied to the log, Sentry, `error_events` and Slack. The scrubber goes deep and covers spans. The feedback DM carries a link only. | `smoke-error-redaction` |
| 1.7 Legal pages | **Factual corrections done** (TERMS_VERSION 2026-10-18) | M-1, 2, 4–11, 13–18, 21 and part of 12. **Not done, for counsel:** §7.6/§7.7 new sections, M-19 (Deepgram wording), M-22–24 (transfers, contact address, age). | `smoke-legal-pages` (lock updated) |
| 1.8 Front door for non-users | **Partly done** | Operator lookup (`scripts/privacy-lookup.ts`, `src/lib/person-lookup.ts`) and runbook procedure. **Needs you:** a monitored privacy email address to publish. **Deferred:** global suppression list (L). | `smoke-person-lookup` |
| 1.9 No-training enforcement | **Done**, except stored acknowledgement | `store: false` on Responses. Batch cleanup (with cancel) on failed and stale batches. Gemini free-tier warning and BYO-key hand-off sentence in Settings. The plan's stored acknowledgement was not built (no schema change); the notice is shown inline. | `smoke-ai-retention` |
| 1.10 Extension disclosure | **Done** in code; Chrome Web Store form **U** | Consent copy names the AI provider, plus a privacy-policy link. | extension typecheck and lint |

Effort: **S** ≤ ½ day · **M** 1–3 days · **L** > 3 days. Regression risk: what could break for users.

Every fix ships with a test that **asserts** the behaviour. Most tests are the existing probes in
`privacy/`, promoted to `scripts/smoke-*.ts` and registered in `scripts/run-smoke.ts`.

---

## Phase 1: Deletion and disclosure gaps that contradict current promises

**Recommended before the first external user.** Items 1.1–1.3, 1.6 and 1.7 are the minimum.

### 1.1 Cancel billing on every deletion path (F-01, M-1)

- **Interim (today, no code):** turn off "Allow users to delete their accounts" in the Clerk
  dashboard, so the only self-serve path is Settings, which cancels correctly. Confirm the
  setting, since the audit could not see it.
- **Approach:**
  - Extract `cancelBillingFor(userId)` from `src/lib/account-deletion.ts`. It reads
    `stripe_customer_id`, then cancels chargeable subscriptions.
  - Call it **before** `purgeUserData` in four places:
    - the Clerk `user.deleted` handler (`src/app/api/webhooks/clerk/route.ts:115-126`);
    - admin `hardDeleteAccount` (`src/lib/admin-operations.ts:~571-596`);
    - admin soft-delete, where the plan says so;
    - `src/lib/clerk-orphan-sweep.ts`.
  - The webhook cannot refuse: the Clerk account is already gone. If cancelling fails, it
    writes the customer id to a new `billing_cancellation_queue` table (customer id plus
    attempts only, no user id) before purging. The nightly ops sweep retries the queue and
    alerts after N failures.
  - Also handle the Stripe `customer.deleted` webhook, clearing any queue entry.
  - ⚖️ Whether to **delete the Stripe customer object** after the final invoice, or keep it
    for tax and records. Today it is never deleted, and that is not disclosed precisely.
- **Files:**
  - `src/lib/account-deletion.ts`
  - `src/app/api/webhooks/clerk/route.ts`
  - `src/lib/admin-operations.ts`
  - `src/lib/clerk-orphan-sweep.ts`
  - `src/app/api/webhooks/stripe/route.ts`
  - `src/db/schema.ts` and `src/db/index.ts` DDL (new table)
  - `src/lib/ops-sweep.ts`
- **Effort:** M. **Risk:** Medium. A double cancel is harmless (Stripe is idempotent on
  cancelled subscriptions). The real risk is a webhook that throws and is retried by Svix, which
  is acceptable.
- **Test:** promote `privacy/probe-account-deletion.ts` [2] into
  `scripts/smoke-clerk-webhook-deletion.ts`. Deliver a signed `user.deleted` event for a user
  with an active subscription and stubbed Stripe. Assert cancel was called before the purge.
  Assert the queue row on a stubbed failure. Same for admin hard-delete and the orphan sweep.

### 1.2 Clear the person from global tables on account deletion (F-05, M-2)

- **Approach:**
  - Add a purge step `marketing` that runs before `preferences`. It deletes, by the account's
    email(s): `interest_list_signups`, `broadcast_recipients`, `waitlist_poll_votes`
    (via `signup_id` and `voter_key`).
  - Read the email at run start and store only `sha256(lower(email))` on the `data_purge_runs`
    row, so a resumed run can still match it after `user_settings` is gone.
  - Re-link anyone whose `referred_by_id` pointed at the deleted signup to null.
  - Replace `detail.email` in `admin_audit_log` with a salted hash at write time
    (`src/lib/admin-operations.ts:517-523,577-583`), or disclose that the audit log keeps the
    email. ⚖️ Which of the two.
- **Files:** `src/lib/user-data.ts`, `src/lib/data-categories.ts` (the step is internal to a full
  purge, like `billing`), `src/lib/admin-operations.ts`.
- **Effort:** S–M. **Risk:** Low. The waitlist rows of active members are untouched because
  matching is on the deleted account's email only.
- **Test:** promote the probe to `scripts/smoke-purge-global.ts`. After deletion, the whole-database
  scan for the user's id **and email** returns only an explicit allowlist:
  - `admin_audit_log`
  - `webhook_deliveries`
  - `data_purge_runs`
  - anonymised `billing_events` and `credit_grants`
  - `page_views` (hash only)
  - `rate_limit_buckets` (≤2 d)

  Any new survivor fails CI.

### 1.3 Stop "undo merge" resurrecting deleted data (F-02, M-3)

- **Approach:**
  - Stop archiving **rebuildable derived rows** (`contact_embeddings`, `recommendations`,
    `contact_briefs`) in `contact_merges.deleted`. On unmerge, mark both contacts
    embedding-stale and let the backfill rebuild them, as `scheduleEmbeddingRebuild` already
    does elsewhere.
  - Every purge step that deletes a table also strips that key from existing
    `contact_merges.deleted` blobs (`UPDATE … SET deleted = deleted - '<table>'`), so archives
    can never hold what a purge removed.
  - Limit unmerge to 30 days. Prune `contact_merges` older than that, deleting the loser
    snapshot.
  - ⚖️ The 30 days is a product call, not a legal one, but disclose it.
- **Files:** `src/lib/contact-merge.ts:290-525,694-899`, `src/lib/user-data.ts` (insights, notes,
  tags and contacts steps), `src/app/api/imports/process-stalled/route.ts` (prune).
- **Effort:** M. **Risk:** Medium. Unmerge fidelity drops slightly: briefs are regenerated, not
  restored. `smoke-contact-merge` must be updated alongside.
- **Test:** promote S4 to `scripts/smoke-unmerge-after-purge.ts`. After an insights purge,
  unmerge re-inserts 0 derived rows, and no `contact_merges.deleted` blob contains a purged key.

### 1.4 Contact deletion: remove dangling references and say what stays (F-03, M-3)

- **Approach:**
  - In `deleteContactsForUser`, inside the same atomic group:
    - remove the id from `memory_chunks.contact_ids`, `ai_suggestions.related_contact_ids` and
      `email_sends.contact_ids`;
    - null `capture_jobs.seed_contact_id` and `import_job_rows.contact_id`;
    - mark every passage that listed the person for re-index, so its derived header and
      subject are rebuilt.
  - Schedule `pruneOrphanedMemoryChunks` (written but never called,
    `src/lib/memory-backfill.ts:343`) in the hourly process-stalled run.
  - Free text the user wrote (notes, chat, transcripts, sent mail) stays, by design. Say so in
    the delete dialog: "Notes, chat and transcripts that mention {name} are yours and are kept.
    [Find them]". Offer a search link.
  - ⚖️ Whether a removal request from that person obliges more than this.
- **Files:** `src/lib/contact-delete.ts`, `src/lib/memory-backfill.ts`,
  `src/app/api/imports/process-stalled/route.ts`, the contact delete dialog in
  `src/components/contacts/`.
- **Effort:** M. **Risk:** Low–Medium (passage re-index load on big deletions; chunk it).
- **Test:** promote S1 to `scripts/smoke-contact-delete-references.ts`. After deletion the contact
  id appears in **no** table. Memory search for the person's name returns no passage whose
  `contact_ids` lists them.

### 1.5 Import revert and undo leave nothing behind (F-04)

- **Approach:**
  - `revertImport` (`src/lib/import-revert.ts:216-262`):
    - use `deleteContactsForUser`, not a raw delete;
    - call `deleteMemoryChunks` for the deleted interaction ids;
    - after a revert or undo, replace `import_job_rows.payload` with `{}` (counts stay);
    - delete the import's `import_files`.
  - Remove the unused `revertImportAction` export, or route it through the same code
    (`src/actions/imports.ts:1964`).
- **Effort:** S. **Risk:** Low.
- **Test:** promote S3. Assert 0 orphan passages and 0 payload rows naming the person.

### 1.6 Keep personal data out of logs, Sentry, `error_events` and Slack (F-06)

- **Approach:**
  - One `redactDbError(err)` helper. For a `DrizzleQueryError`, return
    `Failed query: <sql>` plus `cause.message` (the Postgres code and constraint), and **drop
    `params`**.
  - Apply it in:
    - `reportError` (`src/lib/report-error.ts:87-100`), before the console and Sentry;
    - `recordErrorEvent` (`src/lib/error-events.ts:171-186`);
    - `toUserFacingError` and the Slack fallback (`src/lib/request-errors.ts:36-47`), which
      must also run `scrubUrl` on the request path;
    - each raw `console.warn(…, err)` listed in F-06.
  - `scrubSentryEvent`: recursively scrub non-string `extra` values. Scrub span descriptions.
    Add phone-number patterns.
  - Feedback Slack DM: send category, area and an admin link only, not the text
    (`src/lib/feedback-notify.ts:29-35`).
  - Check Sentry project settings: server-side scrubbing on, retention ≤ 30 days, IP not
    stored. **U**: must be done in the Sentry dashboard.
- **Effort:** S–M. **Risk:** Low (debuggability: SQL stays, values go).
- **Test:** promote `privacy/probe-log-scrub.ts` to `scripts/smoke-error-redaction.ts`. A
  `DrizzleQueryError` carrying name, phone and note prose produces a Sentry event, an
  `error_events.message` and a Slack payload that contain none of them.

### 1.7 Correct the legal pages to match today's behaviour (F-09, M-1…M-24)

- **Approach:** replace the sections in §7 below (draft, for counsel). Specifically:
  - export coverage (M-4)
  - Google revoke (M-5)
  - scopes per feature (M-6, after 3.6)
  - email-activity Limited Use row (M-7)
  - extension sites and AI processing (M-8, M-9)
  - cookies (M-10)
  - expired-session attribution (M-11, or fix the code: Phase 2)
  - training language (M-12, after 1.9)
  - included-AI provider order (M-13)
  - Twilio and Resend scope (M-14, M-15)
  - missing sub-processors (M-16)
  - waitlist email promise (M-17)
  - Terms integration list (M-18)
  - Deepgram wording (M-19, pending vendor confirmation)
  - backup and deletion-replay wording (after 2.3)
  - Fix the misleading comment at `src/app/api/scan/[token]/pages/route.ts:23` (M-21).
  - Bump `TERMS_VERSION` and `LEGAL_LAST_UPDATED` in `src/lib/legal.ts`, so the in-app update
    banner fires.
  - Regenerate `scripts/legal-pages.lock.json`.
- **Effort:** S (copy) plus counsel time. **Risk:** None (copy). `smoke-legal-pages` enforces the
  lock.
- **Test:** `npm run test:check`, and add a `scripts/smoke-legal-claims.ts` that asserts the
  claims the code can check: export category list equals `DATA_CATEGORY_META`, Google scope table
  equals `google-scopes.ts`, sub-processor names ⊇ hosts the code calls.

### 1.8 A front door for people in users' networks (F-08, M-23)

- **Approach:**
  - Publish a monitored privacy address (e.g. `privacy@<domain>`) on /privacy, /terms and
    /contact. Make the contact form's privacy topic always available.
  - Add a /privacy section "If you're in someone's Orbit" (draft §7.6).
  - Build an operator-only, audited tool: "find a person across accounts by email or LinkedIn
    URL". It reports which accounts hold them, without showing content.
  - Add a **global suppression list** (`person_suppressions`: `sha256(lower(email))`,
    LinkedIn slug hash, created_at, reason). It is honoured by:
    - Apollo enrichment;
    - web research;
    - the recruiter directory;
    - the shared avatar pool.

    ⚖️ Whether to also block ingestion into a user's own CRM, which is the user's data as
    controller.
  - Write the request-handling runbook in `docs/RUNBOOK.md`: verify identity, 30-/45-day
    clocks, a log of requests.
- **Effort:** M (address, copy, runbook) plus L (suppression list). **Risk:** Low.
- **Test:** smoke that a suppressed email is skipped by `enrichPerson`, `researchPerson` and the
  recruiter pool writer.

### 1.9 Make the no-training promise enforceable (F-07, M-12)

- **Approach:**
  - Set `store: false` on every OpenAI Responses and Chat Completions call (`src/lib/ai.ts`;
    grep `responses.create` and `chat.completions.create`).
  - Call `cleanup` on the failed and stale batch paths (`src/lib/ai-batch.ts:398-430`).
  - For BYO Gemini keys: when saved, show "Free-tier Gemini keys may let Google use your
    content to improve its products. Use a paid (billing-enabled) key." Record an
    acknowledgement.
  - ⚖️ Whether the policy may still say "anyone else's" given BYO keys. The draft in §7.3
    narrows it honestly.
  - Confirm the managed Gemini project is on paid tier (**U**). Confirm zero-retention
    arrangements, or document the abuse-monitoring windows, for Anthropic and OpenAI.
- **Effort:** S. **Risk:** Low. `store:false` disables OpenAI `previous_response_id` chaining;
  check none is used.
- **Test:** a smoke that stubs the OpenAI client and asserts `store === false` on every call
  site. A batch smoke that asserts cleanup on failure.

### 1.10 Extension disclosure (M-8, M-9)

- **Approach:**
  - Fix the `GrantAccessView` copy to say page text is sent to Orbit **and processed by your
    AI provider**.
  - Add a Privacy Policy link in the panel and the README.
  - Update the Chrome Web Store privacy-practices form to list X, Gmail and any page (generic
    adapter).
- **Files:** `extension/src/panel/views/GrantAccessView.tsx`, `extension/README*`.
- **Effort:** S. **Risk:** None.
- **Test:** a pure smoke grepping the copy for the provider disclosure and the policy URL.

---

## Phase 2: Retention automation and complete export

### 2.1 Retention schedule and one purge job (F-14)

Proposed periods. ⚖️ Every period below is a product proposal for counsel to confirm against
accounting, tax and limitation periods.

| Data | Proposed | Mechanism |
|---|---|---|
| `error_events` | 30 d (keep) | existing |
| Sentry events | 30 d | Sentry setting |
| `page_views`, `usage_events` | 180 d (keep); null `session_id` and city after 30 d | existing plus new |
| `gate_events`, `speech_usage` | 13 months | new |
| `webhook_deliveries` | 13 months (keep `user.deleted` rows 24 months as deletion evidence, or move evidence to tombstones, 2.3) | new |
| `admin_audit_log` | 24 months, email hashed (1.2) | new ⚖️ |
| `data_purge_runs` (done **and failed**) | Longer than backup retention plus 30 d (→ 120 d); failed runs alert, then are retained 120 d | change |
| `feedback` and screenshots | 12 months after resolution | new |
| `import_job_rows.payload`, `revert_snapshot` | Cleared 8 d after an import finishes (undo window 7 d) | new |
| `import_files` (raw LinkedIn CSVs) | Do not store `stored`-role files at all; delete the parsed export 30 d after import | change |
| `email_sends` bodies | 12 months, then keep headers only | new ⚖️ |
| Saved meeting transcripts | Keep while the meeting exists (user content), but offer a per-meeting "delete transcript, keep notes" | UI |
| `ai_batch_jobs`, `outbound_webhook_deliveries`, `connector_outbox` (sent), `agent_send_requests` (expired) | 30 d | new |
| `cron_runs` | 90 d | new |
| `contact_merges` | 30 d (1.3) | new |
| Waitlist rows | Delete 30 d after the person signs up (row converted) or 24 months after the last email, whichever first | new ⚖️ |
| `broadcast_recipients` | 12 months; delete with its signup | new |
| Inactive accounts | Free accounts with no sign-in for 24 months: email at 23 months, then full deletion via `purgeUserData`. Paying and Lifetime accounts excluded. | new ⚖️ |

- **Approach:**
  - One `src/lib/retention.ts` with a declarative table of `{ table, column, olderThan, where }`.
  - Run it from the hourly `process-stalled` route, bounded per run, logging counts to
    `cron_runs`.
  - Wire in the never-called `pruneProviderSnapshots` and `pruneOrphanedMemoryChunks`.
- **Effort:** M (+M for inactive accounts). **Risk:** Medium: deleting data is irreversible, so
  run in dry-run mode for 2 weeks, logging counts only.
- **Test:** `scripts/smoke-retention.ts` seeds rows either side of each threshold and asserts
  exactly the old ones go.

### 2.2 Export: complete, resilient, and honest (F-10, F-11, M-4)

- **Approach:**
  - **Add the missing data:**
    - `contact_opportunities`, `cloud_note_sources`, `job_posting_matches`,
      `embedding_failures`;
    - the credit ledger (`credit_accounts`, `credit_grants`, `credit_holds`,
      `plan_meter_usage`) under `account`;
    - recruiter rows the user created;
    - the user's waitlist row and broadcasts received (by email);
    - `admin_audit_log` entries targeting them, with admin id and reason hashed or redacted ⚖️;
    - `webhook_deliveries` about them.
  - Add `scripts/smoke-export-coverage.ts`: every `user_id` table, and every global table
    reachable by the user's id or email, is either exported or on a documented exclusion list
    with a reason.
  - Add an `"account_links"` section pointing to the Clerk and Stripe self-service portals for
    data Orbit does not hold.
  - **Large accounts:** switch to keyset pagination (`WHERE id > $last`). Write a final
    `"complete": true` marker so a truncated file is detectable.
  - Above a size threshold, build the export in a background job into **private** Blob, and
    email a short-lived signed link (≤24 h, owner-checked proxy route). Delete the file after
    7 days.
- **Effort:** M. **Risk:** Low–Medium (export format change → bump to `orbit-export/3`).
- **Test:** `privacy/probe-export.ts` E3 becomes an assertion (0 unexplained omissions). An E5
  variant at 100k contacts checks the marker.

### 2.3 Backups: deletion replay (F-13)

- **Approach:**
  - Add a `deletion_tombstones` table: `sha256(user_id)` plus `sha256(lower(email))`,
    `deleted_at`, `scope` (`account` or a category list). Write it on every full purge. Keep it
    for backup retention + 30 d (120 d).
  - Prune it after that, so it is not itself a long-lived record.
  - Restore runbook, inserted before "promote the branch" in `docs/RUNBOOK.md`:
    1. Note the dump's timestamp `T`.
    2. On the restored branch, read every tombstone with `deleted_at > T` from **production**.
       Production is the source of truth, because the restored copy predates those deletions.
    3. For each `account` tombstone, find `user_settings` rows whose hashed id matches, and run
       `purgeUserData(id, { keepSettings: false })`. Do the same for waitlist rows by email
       hash.
    4. Re-run the Stripe-cancel queue (1.1) for any restored customer.
    5. Run `privacy/probe-account-deletion`-style scans for 10 sampled tombstones. Promote only
       when they are clean.
    6. Record the replay in the ops log.
  - Run the restore drill ("not yet run", `RUNBOOK.md:251-253`) with this step included.
  - Disclose backup retention and replay (draft §7.2). List GitHub as a sub-processor.
- **Effort:** M. **Risk:** Low.
- **Test:** `scripts/smoke-deletion-replay.ts`:
  1. seed and snapshot (copy rows);
  2. delete the account (tombstone written);
  3. restore the snapshot rows;
  4. run the replay;
  5. assert the scan is clean.

### 2.4 Disconnect means what the dialog says (F-12)

- **Approach:**
  - Record provenance (`source_connection` or import id) on the rows each connector creates.
    Most rows already carry `import_id` or `source`.
  - "Also delete what Orbit imported from this account" then removes contacts it created and
    nobody touched since, its interactions, email activity, `email_sends` (that provider's) and
    their derived passages. This reuses the revert logic from 1.5.
  - Luma and Eventbrite disconnect: offer to delete synced events and rosters.
  - Ship a generic connector disconnect (wire `deleteConnectorConnection`; clean
    `external_links` and `connector_outbox`).
  - Make admin "disconnect integration" call the user path, including the Google revoke
    (`src/lib/admin-operations.ts:391-414`).
  - Apple: link the user to appleid.apple.com to revoke the app-specific password, as Outlook
    does.
- **Effort:** L. **Risk:** Medium: deleting contacts on disconnect must not catch hand-edited
  ones; reuse the `created_at === updated_at` rule.
- **Test:** extend `smoke-disconnect-cleanup` per provider.

### 2.5 Private storage for photos of notes and feedback screenshots (F-17)

- **Approach:**
  - Switch `capture-photos/` and `feedback/` to `access: "private"`, as email attachments
    already are.
  - Serve them only through the existing owner-checked proxies. Migrate existing objects with a
    one-off script, then delete the public copies.
  - Event covers: add a random suffix and refuse SVG.
- **Effort:** M. **Risk:** Medium (image loading paths; test in staging with real Blob).
- **Test:** a smoke asserting every `put(` outside `avatars*` uses `access: "private"`. A staging
  check that old URLs 404.

---

## Phase 3: Consent and third-party-data handling

| # | Item | Approach | Files | Effort | Risk | Verification |
|---|---|---|---|---|---|---|
| 3.1 | Recording consent on **every** entry point (F-15) | <ul><li>One `<RecordingConsentNotice>` used by the meeting panel, the meeting nudge (`meeting-nudge.tsx:59-90`, which today starts recording directly) and voice notes.</li><li>First use: a modal "Everyone on this call can hear you're using Orbit and has agreed. Some places require everyone's consent.", with a recorded `recording_consent_ack_at`.</li><li>Optional copy-to-chat announcement text.</li><li>⚖️ All-party-consent states and EU or UK use.</li></ul> | `src/components/capture/*` | S | Low | Pure smoke: every component that calls the recorder renders the notice |
| 3.2 | BYO-key hand-off notice (F-15) | <ul><li>On switching to "My own key" or saving a key: "From now on, notes, contacts, transcripts and emails you use with AI go to {Provider} under your account's terms with them. [Their data terms]."</li><li>Record the acknowledgement and the provider.</li><li>Show the managed provider order for included AI (M-13).</li></ul> | `src/components/settings/ai-settings.tsx`, `src/actions/settings.ts` | S | Low | Smoke on the action: no key saved without an ack |
| 3.3 | Age and eligibility (M-24) | <ul><li>Sign-up attestation "I'm at least {16/18}" ⚖️, stored with the terms acceptance. Terms updated (§7.8).</li><li>No date of birth collected (minimisation).</li><li>A support path to delete an under-age account.</li></ul> | Clerk sign-up custom field or onboarding `welcome-step.tsx`; `src/lib/legal.ts` | S | Low | Onboarding smoke |
| 3.4 | Waitlist and marketing consent (F-21, M-17) | <ul><li>Waitlist forms: purpose line plus privacy link.</li><li>Separate unticked checkbox "Also send me occasional product news". Broadcasts go only to rows with that opt-in.</li><li>Store a consent record: text version, timestamp, source page.</li><li>Postal address in every commercial email ⚖️.</li><li>Honour unsubscribes within 10 days (already immediate).</li></ul> | `src/components/landing/waitlist-form.tsx`, `src/components/interest/*`, `src/lib/interest-list-join.ts`, `src/lib/broadcasts.ts`, `src/lib/interest-list-email.ts`; schema columns | M | Low | Smoke: broadcast recipients ⊆ opted-in |
| 3.5 | Notification defaults | <ul><li>⚖️ Decide whether the weekly Radar digest (contains contact names) may stay on by default as a service message, or becomes opt-in.</li><li>Credit notices stay on (transactional).</li><li>Site-invite email gets a "not you?" line.</li></ul> | `src/db/schema.ts:588`, `src/lib/radar/digest.ts` | S | Low | — |
| 3.6 | Scope minimisation (F-16, M-6) | <ul><li>Email activity: request `gmail.metadata` (or keep `gmail.readonly` only when the recruiter scan is on).</li><li>Unbundle Settings Connect so each feature asks when turned on.</li><li>Cloud notes: replace `drive.readonly` with Picker plus `drive.file` (also avoids the restricted-scope security assessment).</li><li>Microsoft: `Mail.ReadBasic` for activity, Files only via picker if feasible.</li><li>Re-verify the Google OAuth consent screen and the Limited Use table.</li></ul> | `src/lib/google-scopes.ts`, `src/lib/microsoft-scopes.ts`, `src/lib/sync-scheduler.ts:1076`, `src/lib/legal.ts` | M | Medium (re-consent for existing users) | `smoke-google-scopes`-style pure test per purpose |
| 3.7 | Third-party data handling (F-08) | <ul><li>Suppression list (1.8) enforced at enrichment, research, recruiter pool and avatar pool.</li><li>Recruiter directory: stop writing name, firm and specialty from a **non-sharing** creator onto the canonical row (`src/lib/recruiters.ts:412-424`).</li><li>Apollo prospects (strangers): show the user a "you are the controller" note at search time.</li><li>Keep outreach unshipped until 3.9.</li><li>⚖️ Art. 14 notice to non-users, and whether "disproportionate effort" applies.</li></ul> | `src/lib/apollo.ts`, `src/lib/web-research.ts`, `src/lib/recruiters.ts`, `src/lib/shared-avatars.ts` | L | Medium | Smokes per ingestion point |
| 3.8 | Cookies (F-24, M-10) | <ul><li>Disclose all cookies (§7.5).</li><li>⚖️ For EU and UK visitors, set `orbit_attr` only after consent, or make it a session cookie holding no identifier.</li><li>Shorten `wp_voter` to the poll's life.</li></ul> | `src/proxy.ts`, `src/actions/waitlist-poll.ts` | S–M | Low | Pure smoke over `cookies().set` call sites vs a disclosed list |
| 3.9 | Assistants and API scope (F-18) | <ul><li>Define `orbit:read` and `orbit:write` in Clerk, then set `MCP_OAUTH_REQUIRE_SCOPES=1`.</li><li>Settings → Connected assistants: list and revoke (Clerk OAuth grants) plus API keys.</li><li>Optional key expiry (default 1 year).</li><li>A `read:basic` scope that withholds notes and interaction text.</li><li>Retire `/api/mcp/[token]`.</li></ul> | `src/lib/mcp/oauth.ts`, `src/lib/api/*`, settings UI | M | Medium (assistant disconnects) | Extend `smoke-api-keys` / MCP smokes |
| 3.10 | Outreach compliance (if it ships) | <ul><li>List-Unsubscribe, bounce and complaint suppression for outreach.</li><li>An Orbit-side SMS opt-out list.</li><li>No platform Twilio fallback.</li><li>⚖️ TCPA prior express written consent for marketing texts; CAN-SPAM sender identity.</li></ul> | `src/lib/outreach-send.ts`, `src/app/api/webhooks/resend/route.ts` | M | — | Smoke per rule |

---

## Phase 4: Ongoing practice

| # | Practice | Approach | Effort |
|---|---|---|---|
| 4.1 | **Data-map owner** | <ul><li>Name an owner (today: the operator).</li><li>Check in `privacy/data-map.md`, generated from `privacy/probe-schema-inventory.ts` plus a hand-kept purpose and retention column.</li><li>A CI step fails when the schema adds a table or a PII-looking column not present in the map.</li></ul> | M |
| 4.2 | **PR template privacy check** | <ul><li>Add `.github/pull_request_template.md` with a "Personal data" section (sketch below).</li><li>Mirror it in `AGENTS.md` so coding agents see it.</li></ul> | S |
| 4.3 | **Probes become CI** | <ul><li>Promote each `privacy/probe-*` to an asserting `scripts/smoke-*` as its fix lands.</li><li>Register it in `scripts/run-smoke.ts`.</li><li>The generic seeder (`privacy/lib/seed-everything.ts`) makes every new table automatically covered by the deletion scan.</li></ul> | M |
| 4.4 | **Sub-processor review** | <ul><li>Quarterly diff of outbound hosts (CSP `connect-src` plus a grep of `fetch(`/SDK clients) against the /privacy list. This is the `smoke-legal-claims` check from 1.7.</li><li>Keep vendor DPAs in the private ops repo.</li></ul> | S |
| 4.5 | **Admin hardening** (F-19) | <ul><li>Require MFA for `ADMIN_USER_IDS` (Clerk).</li><li>Step-up re-authentication before viewing contact notes or minting a sign-in link.</li><li>Sign-in link TTL from 7 days to 15 minutes.</li><li>Audit every contact list, search and feedback-screenshot view.</li><li>Enforce the denylist at the query layer, not per call site.</li></ul> | M |
| 4.6 | **Key rotation** (F-20) | <ul><li>Versioned ciphertext `v1:iv:tag:ct` and an `ENCRYPTION_KEYS` keyring (current plus previous).</li><li>Re-encrypt in the background.</li><li>Pin `authTagLength: 16`.</li><li>Derive separate HMAC subkeys with HKDF.</li><li>Run `scripts/backfill-encrypt-ics-urls.ts` in production and then drop plaintext support.</li></ul> | M |
| 4.7 | **Request and incident logs** | <ul><li>Access, deletion and objection requests log, with response deadlines.</li><li>Breach runbook ⚖️ (GDPR 72 h, US state timelines).</li></ul> | S |
| 4.8 | **Annual re-audit** | Re-run `privacy/` probes and this document's §6 table before each Terms version bump. | S |

**PR template sketch (4.2):**

```md
## Personal data
- [ ] This PR does not add, copy, send or log personal data. *(If unchecked, answer below.)*
- New tables/columns holding personal data (account holder or contacts):
- Purged by `purgeUserData` (which category)? Exported? Retention?
- New vendor or new data sent to an existing vendor? Updated /privacy sub-processors?
- New logging/Sentry/Slack fields — could they carry note text, names, emails, phones?
- New OAuth scope or extension permission? Updated consent copy and Limited Use table?
- Smoke: `smoke-purge`, `smoke-export-coverage`, `smoke-purge-global` pass.
```

---

## 5. Jurisdiction map

Plausibly applicable regimes and where each requirement lives in the code. ⚖️ = needs counsel,
including on applicability.

| Regime | Requirement | Where in Orbit | Status |
|---|---|---|---|
| GDPR / UK GDPR ⚖️ (EU or UK users; contacts who are EU or UK residents) | Roles: Orbit as processor for users' CRM data (Terms already call the user the controller, T:206-213) vs controller for the recruiter directory, enrichment, waitlist, analytics | `src/lib/recruiters.ts`, `src/lib/apollo.ts`, `src/lib/web-research.ts` | ⚖️ decide; a DPA for users is then needed |
| | Art. 6 lawful basis for Orbit's own processing (account, analytics, waitlist, cookies) | /privacy has none | Gap: §7.7 draft |
| | Art. 13/14 notice; Art. 14 to non-users | /privacy; none for non-users | Gap (1.8, 3.7) |
| | Art. 15/20 access and portability | `src/lib/data-export.ts` | Mostly met (F-10) |
| | Art. 17 erasure, incl. backups | `src/lib/user-data.ts`; backups | Gaps F-01–F-05, F-13 |
| | Art. 25 minimisation | Unused fields §2.3 | Gap |
| | Art. 28 processors and DPAs | §3.1 list | U |
| | Art. 30 records | `privacy/data-map.md` (4.1) | Gap |
| | Art. 32 security | `src/lib/crypto.ts`, admin | Partly (F-17–F-20) |
| | Art. 33/34 breach | none | Gap (4.7) |
| | Ch. V transfers (SCCs, DPF) | /privacy P:621-624 | Gap ⚖️ |
| | Art. 27 EU/UK representative | none | ⚖️ |
| | Art. 8 child consent age 13–16 | Terms 13+; no gate | ⚖️ (3.3) |
| CCPA/CPRA ⚖️ (applies above thresholds: >$25M revenue, 100k consumers, or selling/sharing; likely not yet) | Notice at collection, right to know/delete/correct, sensitive PI, "Do Not Sell or Share" | /privacy; export; purge | Prepare language (§7.7); no sale or share claimed (verify Vercel Analytics and cookies count as neither) |
| Other US state laws (VA, CO, CT, UT, TX, OR, …) ⚖️ | Similar rights; Texas TDPSA covers non-small businesses regardless of revenue; sensitive data (precise geolocation: Orbit stores city only) | as above | ⚖️ thresholds |
| CAN-SPAM | Commercial email: accurate sender, clear opt-out honoured ≤10 business days, **postal address** | `src/lib/interest-list-email.ts`, `src/lib/broadcasts.ts`, digest, outreach | Gap: no postal address (3.4) |
| TCPA | Marketing SMS needs prior express written consent; STOP handling | `src/lib/outreach-send.ts` (unshipped) | Hold outreach (3.10) |
| Wiretap / all-party consent (e.g. CA Penal Code 632, ~a dozen US states; EU/UK rules) ⚖️ | Consent of everyone on a recorded call | Meeting capture | Partial notice (3.1) |
| COPPA | No knowing collection under 13 | Terms 13+ | ⚖️ age gate (3.3) |
| Google API Services User Data Policy, Limited Use; restricted-scope security assessment | Limited Use statement; minimum scopes; restricted scopes (`gmail.readonly`, `drive.readonly`) need annual assessment | `src/lib/google-scopes.ts`, `src/lib/legal.ts` | Statement present; scope breadth F-16 |
| Chrome Web Store User Data Policy | Prominent disclosure; privacy policy; limited use | `extension/` | Gap (1.10) |
| Microsoft identity platform terms / publisher verification | Accurate consent, minimum permissions | `src/lib/microsoft-scopes.ts` | F-16 |
| ePrivacy / PECR ⚖️ | Consent for non-essential cookies (`orbit_attr`) | `src/proxy.ts` | ⚖️ (3.8) |
| FERPA? ⚖️ | Probably not applicable (Orbit is not an education institution's agent), but student users and school-affiliated deployments should be checked | — | ⚖️ |

---

## 6. Questions for a lawyer

1. **Roles.** For contacts a user stores, is Orbit a processor (with a DPA offered to users) or
   a joint or independent controller? For the shared recruiter directory, Apollo enrichment of
   strangers, web-research dossiers, the shared LinkedIn photo pool and the waitlist, is Orbit
   the controller? What lawful basis applies to each?
2. **Article 14.** Must Orbit notify people whose data users add, or enrich via Apollo or web
   search? Does the "disproportionate effort" exemption apply, and what compensating measures
   (public notice, suppression list) are expected?
3. **Erasure scope.** When a non-user asks to be removed, must Orbit remove them from every
   user's private CRM, or only from data Orbit controls (directory, enrichment, avatar pool)?
   What about free text in users' notes?
4. **Backups.** Is 90-day encrypted backup retention plus a deletion-replay step on restore
   adequate under GDPR Art. 17 and state laws? How should it be disclosed?
5. **Stripe customer.** May or must Orbit delete the Stripe customer object after account
   deletion, given tax and record-keeping duties? For how long may the anonymised billing ledger
   and the admin audit log (with email) be kept?
6. **AI training language.** Given bring-your-own keys (including free tiers), what can Orbit
   truthfully promise about training? Is the narrowed draft in §7.3 acceptable? Do provider
   abuse-monitoring retention windows need listing?
7. **Deepgram.** Does `mip_opt_out=true` support the phrase "zero retention", or should the
   policy quote Deepgram's own wording?
8. **Recording consent.** Is an in-app reminder plus a user acknowledgement sufficient for
   all-party-consent jurisdictions, or must Orbit block recording until the user confirms
   consent for each meeting?
9. **Age.** What minimum age for a networking CRM with many students: 13, 16 (EU default) or 18?
   Is a self-attestation enough? Any FERPA or COPPA exposure from school-related use?
10. **Waitlist and marketing.** Is a waitlist welcome email "transactional"? Do broadcasts
    require a separate opt-in in the EU and UK (PECR soft opt-in does not cover non-customers)?
    Which postal address satisfies CAN-SPAM for a sole operator?
11. **Cookies.** Does `orbit_attr` (first-touch referrer and UTM, 90 days, copied to the
    account) need consent in the EU and UK? Is the daily-salted visitor hash personal data
    there?
12. **Retention periods.** Confirm the table in 2.1, especially inactive-account deletion at
    24 months, the 12-month `email_sends` body retention, and audit-log retention.
13. **International transfers.** What mechanism should be named (SCCs, EU-US DPF reliance by
    vendors)? Is an EU or UK representative needed at current scale?
14. **Applicability thresholds.** Which US state laws apply now? Is Orbit a "business" under
    CCPA? Is page-view analytics with city-level location tied to an account a "sale" or
    "share"? (Engineering believes no.)
15. **Terms.** Governing law is currently "where the operator is established" with no place
    named. Should a specific jurisdiction be named? Is waitlist browsewrap acceptance (T:94)
    enforceable?
16. **Admin access.** Is the operator's full read access to contact notes, which is disclosed,
    acceptable? What logging and controls are expected?

---

## 7. Draft replacement language for /privacy and /terms

> **DRAFT for counsel's review. Not final, not legal advice.** Wording in `{braces}` is a
> placeholder for a decision above. Each block replaces or adds the named section of
> `src/app/(site)/(docs)/privacy/page.tsx` or `.../terms/page.tsx`. Ship only after the
> engineering item it depends on is done, noted per block.

### 7.1 /privacy: Highlights (replaces `HIGHLIGHTS`, P:27-32)

> **Your network isn't a product.** Orbit doesn't sell personal information or run advertising
> pixels. Its own traffic analytics don't use cookies to recognise you; the cookies Orbit does
> set are listed under Cookies.
>
> **AI runs on Orbit's accounts or your own key.** Included AI runs on Orbit's accounts with
> Anthropic, then OpenAI as backup. If you add your own key, your data goes to that provider
> under your agreement with them.
>
> **Export everything.** One control in Settings downloads your Orbit data as JSON, on every
> plan.
>
> **Deletion is real deletion.** Delete some or all of your data from Settings, or delete your
> account. Deleting your account cancels any subscription, erases your data, keys and sign-in,
> and removes your waitlist record. *(Depends on 1.1 and 1.2.)*

### 7.2 /privacy: Your controls and How long data is kept (replaces P:505-560)

> **Export.** Settings → Data and privacy → Export downloads everything Orbit holds about your
> account, across 16 categories:
> - contacts and companies;
> - notes, captures, transcripts and photos (as links you can open while signed in);
> - reminders, imports, connected-account records, events, goals and chat;
> - recruiters, API keys (without the secret), usage and diagnostics, and feedback;
> - outreach, tags and preferences;
> - the AI-generated data Orbit derived from them;
> - and your billing and credit history.
>
> Passwords, keys, tokens and search vectors are left out. Data held by Clerk (your sign-in)
> and Stripe (your payments) is available from their own account pages, linked in the export.
> *(Depends on 2.2 for completeness.)*
>
> **Delete data.** Choose categories to delete. Your account, plan and API keys stay. Deleting a
> contact removes everything Orbit derived about them: search index, AI summaries, suggestions
> and links. Notes, chat messages, transcripts and emails *you wrote* that mention them are kept
> until you delete those too. *(Depends on 1.3–1.5.)*
>
> **Delete your account.** This cancels any active subscription and erases all of your Orbit
> data and settings, including keys, connected accounts and your waitlist record. It also
> removes your sign-in. The same happens if you delete your account from the Clerk account
> page. *(Depends on 1.1, 1.2.)*
>
> **What remains after deletion:**
> - Stripe's own records of your payments, held by Stripe for {tax/record period}.
> - Orbit's accounting record of charges, refunds and credit packs, with your account id
>   removed.
> - The operator's log of actions taken on your account. It refers to your former account id
>   {and a one-way hash of your email}, and is kept for {24 months}.
> - Short-lived operational records: rate-limit counters (2 days) and a record of the deletion
>   itself ({120 days}).
>
> **Backups.** Orbit keeps encrypted database backups for 90 days, so deleted data leaves the
> last backup within 90 days. If a backup is ever restored, Orbit re-applies every deletion
> made after the backup was taken before the restored data is used.
> *(Depends on 2.3.)*
>
> **Retention while your account is open.** {Insert the table from Plan 2.1 as finally approved,
> in plain language.}
>
> **Inactive accounts.** If you haven't signed in for {24 months} on the Free Plan, Orbit emails
> you, and deletes the account 30 days later unless you sign in. *(Depends on 2.1.)*

### 7.3 /privacy: How AI is used (replaces P:236-237 and P:377-387 training language)

> Orbit does not use your content to train AI models. Included AI runs under Orbit's agreements
> with Anthropic and OpenAI, which do not allow your content to be used for training. Those
> providers may keep requests for a limited period to detect abuse ({list windows}).
>
> If you use your own key, your content goes to that provider under *your* agreement with them,
> and their terms decide whether it may be used for training. Some free tiers, including
> Google's free Gemini API tier, allow it. Orbit warns you when you add a key, and recommends a
> paid key. *(Depends on 1.9.)*
>
> Transcription uses Deepgram on Orbit's account with Deepgram's model-improvement opt-out set
> on every request, {which Deepgram documents as …}.

### 7.4 /privacy: Browser extension (replaces P:183-190)

> The extension reads a page only when you open its panel on that page, and only on sites you
> have allowed: LinkedIn, X, Gmail (participants' names and addresses, never message bodies),
> Luma and Partiful, or any other page you choose to save from.
>
> What it reads (a profile's name, title, company, location, photo link and visible page text,
> or a guest list) is sent to your Orbit account. Orbit's AI provider then turns it into a
> contact. Page text is cached for 7 days so a repeat save is instant. The extension sends
> nothing anywhere else and contains no analytics. *(Depends on 1.10.)*

### 7.5 /privacy: Cookies (replaces P:439-448)

> Orbit sets these cookies:
>
> | Cookie | Purpose | Lifetime |
> |---|---|---|
> | Clerk session cookies | Keep you signed in | Session |
> | `orbit_attr` | Remembers which site or campaign first brought you to Orbit, saved to your account if you sign up | 90 days |
> | `orbit-tz` | Your time zone, so reminders show at the right hour | 1 year |
> | `wp_voter` | Stops double voting in a waitlist poll | {poll duration} |
> | Short-lived sign-in state cookies | Protect Google, Microsoft, Eventbrite and OpenRouter connections | Minutes |
>
> Orbit's own page-view analytics use no cookie: they count visits with a code derived from your
> IP address and browser that changes every day, and never store the IP. {EU/UK: `orbit_attr` is
> set only if you accept it.} *(Depends on 3.8.)*

### 7.6 /privacy: New section, "If you're in someone's Orbit"

> Orbit users keep records of people they know: names, work details, and notes from
> conversations. Some details come from what users type; some from their email, calendar or
> event accounts; some from public sources such as LinkedIn photos and news, and, if a user
> turns it on, from Apollo or web search. The user decides what to keep about you and is
> responsible for it.
>
> Orbit itself controls a few things that can include you:
> - a shared directory of recruiters' work contact details, built only from users who opt in to
>   share;
> - a shared cache of public LinkedIn profile photos;
> - {enrichment results}.
>
> **To ask what Orbit holds about you, or to have it removed,** email {privacy@…}. Orbit will:
> - search every account for your email address or LinkedIn profile;
> - remove you from the data Orbit controls;
> - tell the users who hold you that you asked;
> - and, if you ask, add you to a do-not-enrich list so Orbit's tools don't look you up again.
>
> Orbit answers within {30} days. *(Depends on 1.8. ⚖️ Q1–Q3.)*

### 7.7 /privacy: New section, "Your rights and how to use them"

> Depending on where you live, you may have the right to:
> - access, correct, export or delete your personal data;
> - object to or restrict some processing;
> - withdraw consent;
> - complain to a data-protection authority.
>
> Most of these work directly in Settings. For anything else email {privacy@…}. Orbit verifies
> it is you before acting, and responds within {30 days (GDPR) / 45 days (US state laws)}. Orbit
> does not sell or share personal information for cross-context behavioural advertising.
>
> **Legal bases** (EU and UK):
> - running your account and the features you use: contract;
> - security, abuse prevention and product analytics: legitimate interests;
> - waitlist product news and optional cookies: consent;
> - billing records: legal obligation.
>
> **International transfers:** {mechanism}. **Contact:** {operator name, postal address, email}.
> ⚖️ Q1, Q13.

### 7.8 /terms: Eligibility (replaces T:126-130)

> You must be at least {16 / 18} years old to use Orbit, and you confirm this when you sign up.
> If you are using Orbit for a school, club or employer, you must have their permission where
> it is required. ⚖️ Q9. *(Depends on 3.3.)*

### 7.9 /terms: Your content and other people's data (adds to T:206-213)

> You are responsible for having a lawful reason to keep the information you store about other
> people, and for honouring their requests. When you record or transcribe a conversation, you
> must tell everyone on it and get their consent where the law requires it, which in many places
> means everyone's. Orbit may pass on a person's request about their data to you and may remove
> them from data Orbit controls. ⚖️ Q8.

### 7.10 /terms: AI and training (replaces T:216)

> We don't sell your content and don't use it to train AI models, ours or our providers'. If you
> connect your own AI provider key, that provider's terms with you govern its use of your
> content. *(Aligns with 7.3.)*

### 7.11 /terms: Integrations (replaces T:228-231 Microsoft entry)

> Microsoft (Outlook contacts, calendar, mail reading for the features you turn on, sending
> mail you send, and OneDrive files you choose).

---

## 8. Suggested order and checkpoints

1. **Week 1:**
   - 1.1 (incl. the Clerk dashboard interim switch), 1.2, 1.6 and 1.7.
   - Copy fixes that don't wait on code: M-4, M-5, M-13–M-18, M-21.
   - Run `privacy/` probes. Expected:
     - F-01 path calls cancel;
     - no undocumented survivors;
     - scrubber clean.
2. **Week 2:** 1.3, 1.4, 1.5, 1.9, 1.10. Promote S1–S4 to asserting smokes. Counsel review of §7.
3. **Weeks 3–4:** Phase 2 (retention in dry-run first, export v3, deletion replay plus restore
   drill, private Blobs).
4. **Then:** Phase 3 by risk (3.1, 3.2, 3.4 first), and Phase 4 practices.

Each checkpoint ends with `npm run test:check && npx tsx scripts/run-smoke.ts --ci` and
the `privacy/` probes.
