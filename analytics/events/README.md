# Event ownership document
One section per event in `src/lib/product-event-schemas.ts`. Owner of every event: the founder. `scripts/smoke-product-events.ts` fails when an event has no section here, or a section names an event that no longer exists.
Format per event: **fires when** / **must not fire when** / **read by**. Property definitions live in the zod schema, which is the source of truth; free text never belongs in an event (a survey note goes to `feedback`).
`gate_hit` is the one event recorded in its own table (`gate_events`) and is documented here for completeness.

## waitlist_shared
- Fires when: a share control is used on the waitlist pass (copy, native share, LinkedIn, ticket download).
- Must not fire when: the page merely renders the share row.
- Read by: Referral loop (F4); which share channel works.
- Added: v181.

## waitlist_join_limited
- Fires when: the join limiter (`interest.join`) refuses a real submission, or cannot count and the join is answered with the fake ticket. Actor `system`, no user, no address, no IP: a bare count by reason.
- Must not fire when: a honeypot or BotID block (those are bots and never reach the limiter), or any join that wrote a row.
- Read by: How many humans did the limiter drop (a campus NAT during an event).
- Added: v181.

## waitlist_email_sent
- Fires when: Resend accepted a waitlist welcome or referral-tier email. Actor `system`; carries `kind` only, never the address.
- Must not fire when: the send was skipped (welcome cap, no Resend key) or Resend rejected it (that is an `error_events` row).
- Read by: Welcomes delivered per wave; welcome-sent versus joined.
- Added: v181.

## invite_sent
- Fires when: `inviteToSite` creates an invitation or grants an existing account access; one per invite row.
- Must not fire when: a revoke, or a resend of the same invitation.
- Read by: Wave sizing (F5).
- Added: v181.

## invite_accepted
- Fires when: `linkInviteToAccount` (the Clerk `user.created` webhook, the existing-account grant, or the onboarding backstop `claimSiteInviteGrant`) first accepts an invite for an account; one per invite (deterministic id). `days_since_sent` is whole days from `site_invites.sent_at`.
- Must not fire when: an account created without an invite, a second run of the same claim, or an invite someone else already accepted.
- Read by: Invite to account (F6, F7).
- Added: v181.

## first_app_load
- Fires when: the beacon route (`/api/p/v`) sees the first signed-in page view of an account created in the last two days that has no `signup_session_id`; that view's per-tab session id is written to the account in the same step. One per account (deterministic id).
- Must not fire when: any later view, a bot, a demo account, or an account older than two days (its signup session is unknowable).
- Read by: Closes the anonymous-session to account chain.
- Added: v181.

## onboarding_path_chosen
- Fires when: `startOnboardingPath` records which path the person picked (`tour` or `quick`). One per account, ever (the event id hashes the user).
- Must not fire when: a replayed tour or a second choice after Settings reset onboarding.
- Read by: Activation by path.
- Added: v181.

## onboarding_step_completed
- Fires when: `saveOnboardingStep` or `saveTourStop` moves the person PAST a step (the step they leave is the one completed; going back completes nothing). `step` is the step or tour stop id with every non-letter turned into `_` (`ai-key` -> `ai_key`, `reminders.done` -> `reminders_done`). Event id hashes user, path and step.
- Must not fire when: a step the person has already completed, which includes every step of a replayed tour.
- Read by: Where onboarding loses people.
- Added: v181.

## ai_key_added
- Fires when: `applyAiKeyChange` turns an absent key into a present one for a chat provider, or `saveDecisionKey` does for TypeSafe (`provider: typesafe`). One per (account, provider): the event id hashes both, so clearing and re-adding the same provider is not a second event. The account's first key also stamps `user_settings.ai_key_added_at` (never moved or cleared; a legacy account that already had a key stays NULL = unknown). The TypeSafe key does not stamp it, because it does not make chat AI ready.
- Must not fire when: a replacement, a clear, or an unchanged re-save.
- Read by: AI-ready rate (F8): the bring-your-own-key cliff.
- Added: v181.

## ai_key_check_failed
- Fires when: the key validation rejects a key the person entered in Settings (`error_kind` is `rejected` or `malformed`). Not yet recorded from the OpenRouter OAuth callback.
- Must not fire when: the key was never submitted, or the provider merely did not answer (the key is then saved with a note).
- Read by: Why people stall at the key step.
- Added: v181.

## capture_saved
- Fires when: the capture runner finishes a save (`runCaptureJobById`, after `saveCaptureJob` moved the job to saving); once per job (the event id hashes the event name and the job id, so a resumed save lands on the same row). The reviewed-and-confirmed path (`confirmBulkCapture`) records it too, with the note batch id in place of a job id (`source_kind` is `meeting` for a recorded meeting, otherwise from the input labels).
- Must not fire when: the job is discarded or the save is retried.
- Read by: Activation (F9), capture depth.
- Added: v181.

## capture_failed
- Fires when: a capture job ends `failed`: in `runCaptureJobById` (parse, save), when the stall sweep or a stalled poll gives up (`stalled`), when an upload is abandoned part-way (`abandoned`), or `failCaptureJob` is called without a stage (ingest). `error_kind` is a machine code (`eventErrorKind`), never the message.
- Must not fire when: a user cancel or discard.
- Read by: Capture failure rate (§2.8).
- Added: v181.

## capture_discarded
- Fires when: the person discards a capture (`discardCaptureJob`, `discardCaptureBatch`, including Stop on an upload); `people_proposed` is the cards the parse offered. One per job.
- Must not fire when: an automatic cleanup of a stale job.
- Read by: Whether captures are trusted.
- Added: v181.

## import_failed
- Fires when: `failImport` marks an import failed (first time only; a second call for an already-failed import records nothing). `error_kind` is the stored `errorCode` (`needs_reconnect`, `contact_limit`, ...), `rows_failed` the stats' failed-row count.
- Must not fire when: a row-level skip within a completed import.
- Read by: Import failure rate by provider.
- Added: v181.

## followup_set
- Fires when: a reminder is created or rescheduled by the person (`createReminderForUser`, `scheduleContactFollowUpForUser` when the caller passes an origin, `scheduleFromSuggestion`, `confirmSuggestedReminder`). Event id is a hash of reminder id and due day.
- Must not fire when: Orbit generates a suggestion nobody accepted (the Radar autopilot, the nightly follow-up queue), or calendar sync creates one.
- Read by: Activation half 2 (F10).
- Added: v181.

## followup_completed
- Fires when: any path that moves a reminder to done (`completeReminder`: `markReminderDone`, `completeFollowUpWithTouch`, each reminder in `bulkReminderAction`, an assistant or API completion), on the pending-to-done transition only, alongside `reminders.completed_at`. `days_late` is days after the due date rounded to the nearest whole day (negative when early) and is omitted when the reminder has no due date. Event id is a hash of reminder id and `completed_at`, so a retry dedupes.
- Must not fire when: a dismiss or a delete, a second completion of an already-done reminder, or the relationship engine closing a reminder because a note says it was done (it stamps `completed_at` but is not the person acting).
- Read by: Value metric (§2.5), F11.
- Added: v181.

## followup_snoozed
- Fires when: `snoozeReminder` or `snoozeReminderTo` moves a reminder's due date (the snooze button, the date picker, a bulk snooze). Event id is a hash of reminder id and new due day.
- Must not fire when: an unsnooze (undo).
- Read by: Nudge timing.
- Added: v181.

## followup_dismissed
- Fires when: a reminder is deleted (`dismissReminder`), or a person dismisses a suggestion (`dismissSuggestion`, `discardSuggestedReminder`; `reminder_id` then holds the suggestion id). One per id.
- Must not fire when: a completion, or a suggestion resolved by accepting it.
- Read by: Whether suggestions are trusted.
- Added: v181.

## chat_answer_landed
- Fires when: `persistAssistantTurn` stores a finished answer. `tool_rounds` is the research loop's rounds (0 when one retrieval answered), `evidence_count` the number of cited sources, never their content; keyed by the message id.
- Must not fire when: a discarded or empty turn.
- Read by: Chat latency and depth.
- Added: v181.

## chat_answer_failed
- Fires when: the chat stream ends in an error before an answer is stored (`trackChatAnswerFailed`, from the route's error branch). `error_kind` is a machine code, or the AI gate's reason (`managed_limit`, `key_required`).
- Must not fire when: a client abort.
- Read by: Chat failure rate.
- Added: v181.

## mcp_connected
- Fires when: the first MCP request from a (user, client, via) triple, where `client` is claude, chatgpt or other (from the OAuth client id, the `initialize` clientInfo name or the User-Agent) and `via` is oauth or api_key. Deterministic id, so a cold server instance or a retry cannot double it. Creating an API key is not wired to it yet (`createApiKey` is outside this workstream); the key's first request emits the same row.
- Must not fire when: a repeat request, or one that failed authentication.
- Read by: MCP connected (§2.2).
- Added: v181.

## mcp_tool_called
- Fires when: `runTool` finishes, including refusals (ok=false).
- Must not fire when: authentication failed before a user was known.
- Read by: MCP first call, weekly return, WAN.
- Added: v181.

## mcp_disconnected
- Fires when: an OAuth grant or key is revoked.
- Must not fire when: an expiry.
- Read by: MCP retention.
- Added: v181.

## extension_installed
- Fires when: the first authenticated extension request after install carries `X-Orbit-Install: 1` (the extension sends it on the first `/me` and clears the marker once answered), with a valid `X-Orbit-Extension-Version`. One per account (deterministic id), so a reinstall or a second browser does not count twice.
- Must not fire when: a later session probe, or a request with no valid version header.
- Read by: Extension installs (§2.2).
- Added: v181.

## extension_action
- Fires when: an `/api/extension/*` route performs a user action: `POST /contacts` (save_person), `POST /interactions` (log_interaction), `POST /event-roster` (event_roster), `POST /starters` (starters), `POST /follow-ups` (schedule_follow_up), `POST /signals` (save_activity). `site` is the page adapter's site (linkedin, gmail, luma, partiful) or `other`.
- Must not fire when: the session probe `GET /me`, the background `POST /resolve` and `POST /parse`, or the contact search `GET /contacts`.
- Read by: Extension first use, weekly return.
- Added: v181.

## extension_uninstalled
- Fires when: the uninstall URL is opened.
- Must not fire when: an update or disable.
- Read by: Extension churn.
- Added: v181.

## checkout_started
- Fires when: a Stripe checkout session is created (`startSubscriptionCheckout`, `startCreditPackCheckout`; Lifetime is not sold, so has no start). One per Stripe session. `from_gate` is the `?gate=` the paywall passed to `/upgrade` when it is a known gate key, else the most recent `gate_events` feature for the account in the last 24 hours, else absent. A credit pack's `plan` is the account's own plan and `interval` is `once`.
- Must not fire when: a gate refusal that never reached Stripe (that is a gate hit).
- Read by: F15; gate to upgrade; abandonment.
- Added: v181.

## subscription_canceled
- Fires when: `cancelSubscription` succeeds in setting cancel-at-period-end. `tenure_days` is whole days since the account was created; `reason` is optional and only recorded when it is one of the closed `CANCEL_REASONS` (nothing collects it yet). One per cancellation (the event id hashes the user and the period end).
- Must not fire when: a resume, or Stripe ending a subscription for non-payment.
- Read by: Churn reasons.
- Added: v181.

## error_shown
- Fires when: the client renders a server failure to the person (toast or error state).
- Must not fire when: an error nobody saw.
- Read by: Failures that touched users.
- Added: v181.

## sync_failed
- Fires when: a Google, Outlook or iCloud calendar/contacts connection's sync stops for good: a dead grant (disarmed at once), or the failure that spends the last retry (`MAX_SYNC_FAILURES`). Recorded by `runSyncPass`. Luma, Eventbrite and the event iCal feeds (`event_provider_connections`) record it the same way from `markEventSyncResult`, with provider `ics_feed` for the iCal kinds. Calendar subscriptions (`/imports` ICS URLs) have no terminal state (a failing feed just waits out the stale window), so they record nothing; the recruiter inbox scans are not recorded either.
- Must not fire when: a retried-then-recovered run.
- Read by: Sync failure rate.
- Added: v181.

## email_send_failed
- Fires when: an outbox send reaches a terminal failed state (`settleFailed`: permanent, auth, exhausted, ambiguous). `kind` is `followup` for the follow-up origin and `outreach` for every other; the demo provider records nothing. One per row.
- Must not fire when: a retry in progress.
- Read by: Email failure rate.
- Added: v181.

## survey_shown
- Fires when: a micro-survey is displayed.
- Must not fire when: it was suppressed by the cadence rule.
- Read by: Survey response rate.
- Added: v181.

## survey_dismissed
- Fires when: the person dismisses a survey.
- Must not fire when: an answer.
- Read by: Survey fatigue.
- Added: v181.

## survey_answered
- Fires when: the person answers a closed question.
- Must not fire when: a free-text note (that goes to `feedback`, never here).
- Read by: Qualitative loop, tied to cohorts.
- Added: v181.

## account_deleted
- Fires when: `deleteOwnAccount` is about to purge; written with `user_id` null.
- Must not fire when: an admin suspension.
- Read by: Churn by tenure and reason.
- Added: v181.

## gate_hit
- Fires when: any plan or allowance gate refuses an action, including managed-credit exhaustion, the background floor and speech caps; recorded in `gate_events` with `context.surface` and `context.route`.
- Must not fire when: the gate allowed the action.
- Read by: the Demand page; last gate before conversion.
- Added: pre-v181 (coverage widened in v181).
