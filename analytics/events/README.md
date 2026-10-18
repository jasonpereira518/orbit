# Event ownership document
One section per event in `src/lib/product-event-schemas.ts`. Owner of every event: the founder. `scripts/smoke-product-events.ts` fails when an event has no section here, or a section names an event that no longer exists.
Format per event: **fires when** / **must not fire when** / **read by**. Property definitions live in the zod schema, which is the source of truth; free text never belongs in an event (a survey note goes to `feedback`).
`gate_hit` is the one event recorded in its own table (`gate_events`) and is documented here for completeness.

## waitlist_shared
- Fires when: a share control is used on the waitlist pass (copy, native share, LinkedIn, ticket download).
- Must not fire when: the page merely renders the share row.
- Read by: Referral loop (F4); which share channel works.
- Added: v171.

## invite_sent
- Fires when: `inviteToSite` creates an invitation or grants an existing account access; one per invite row.
- Must not fire when: a revoke, or a resend of the same invitation.
- Read by: Wave sizing (F5).
- Added: v171.

## invite_accepted
- Fires when: `claimSiteInviteGrant` links a new account to its invite.
- Must not fire when: an account created without an invite.
- Read by: Invite to account (F6, F7).
- Added: v171.

## first_app_load
- Fires when: the first signed-in `(app)` render of an account, from `captureAttribution`.
- Must not fire when: any later render.
- Read by: Closes the anonymous-session to account chain.
- Added: v171.

## onboarding_path_chosen
- Fires when: `startOnboardingPath` records which path the person picked.
- Must not fire when: a replayed tour.
- Read by: Activation by path.
- Added: v171.

## onboarding_step_completed
- Fires when: `saveOnboardingStep` or `saveTourStop` advances a step.
- Must not fire when: a step the person has already completed.
- Read by: Where onboarding loses people.
- Added: v171.

## ai_key_added
- Fires when: `applyAiKeyChange` turns an absent key into a present one for any provider.
- Must not fire when: a replacement, a clear, or an unchanged re-save.
- Read by: AI-ready rate (F8): the bring-your-own-key cliff.
- Added: v171.

## ai_key_check_failed
- Fires when: the key validation call rejects a key the person entered.
- Must not fire when: the key was never submitted.
- Read by: Why people stall at the key step.
- Added: v171.

## capture_saved
- Fires when: `saveCaptureJob` commits a batch; once per job (deterministic id = job id).
- Must not fire when: the job is discarded or the save is retried.
- Read by: Activation (F9), capture depth.
- Added: v171.

## capture_failed
- Fires when: a capture job ends `failed` in `runCaptureJobById`, at the stage that failed.
- Must not fire when: a user cancel or discard.
- Read by: Capture failure rate (§2.8).
- Added: v171.

## capture_discarded
- Fires when: the person discards a reviewed batch without saving.
- Must not fire when: an automatic cleanup of a stale job.
- Read by: Whether captures are trusted.
- Added: v171.

## import_failed
- Fires when: `failImport` marks an import failed.
- Must not fire when: a row-level skip within a completed import.
- Read by: Import failure rate by provider.
- Added: v171.

## followup_set
- Fires when: a reminder is created by the person (`createReminderForUser`, `scheduleContactFollowUpForUser`, `scheduleFromSuggestion`).
- Must not fire when: Orbit generates a suggestion nobody accepted, or calendar sync creates one.
- Read by: Activation half 2 (F10).
- Added: v171.

## followup_completed
- Fires when: `markReminderDone`, `completeFollowUpWithTouch`, or each reminder in `bulkReminderAction`, alongside `reminders.completed_at`.
- Must not fire when: a dismiss or a delete.
- Read by: Value metric (§2.5), F11.
- Added: v171.

## followup_snoozed
- Fires when: `snoozeReminderAction`.
- Must not fire when: an unsnooze.
- Read by: Nudge timing.
- Added: v171.

## followup_dismissed
- Fires when: `dismissSuggestion` or a reminder dismiss.
- Must not fire when: a completion.
- Read by: Whether suggestions are trusted.
- Added: v171.

## chat_answer_landed
- Fires when: `persistAssistantTurn` stores a finished answer.
- Must not fire when: a discarded or empty turn.
- Read by: Chat latency and depth.
- Added: v171.

## chat_answer_failed
- Fires when: the chat stream ends in an error before an answer is stored.
- Must not fire when: a client abort.
- Read by: Chat failure rate.
- Added: v171.

## mcp_connected
- Fires when: the first request from a (user, client) pair, or an API key is created.
- Must not fire when: a repeat request.
- Read by: MCP connected (§2.2).
- Added: v171.

## mcp_tool_called
- Fires when: `runTool` finishes, including refusals (ok=false).
- Must not fire when: authentication failed before a user was known.
- Read by: MCP first call, weekly return, WAN.
- Added: v171.

## mcp_disconnected
- Fires when: an OAuth grant or key is revoked.
- Must not fire when: an expiry.
- Read by: MCP retention.
- Added: v171.

## extension_installed
- Fires when: the first authenticated `/api/extension/me` after install carries the install marker.
- Must not fire when: a later session probe.
- Read by: Extension installs (§2.2).
- Added: v171.

## extension_action
- Fires when: an `/api/extension/*` route performs a user action.
- Must not fire when: the session probe or a background resolve.
- Read by: Extension first use, weekly return.
- Added: v171.

## extension_uninstalled
- Fires when: the uninstall URL is opened.
- Must not fire when: an update or disable.
- Read by: Extension churn.
- Added: v171.

## checkout_started
- Fires when: a Stripe checkout session is created (`startSubscriptionCheckout`, `startCreditPackCheckout`, Lifetime).
- Must not fire when: a gate refusal that never reached Stripe (that is a gate hit).
- Read by: F15; gate to upgrade; abandonment.
- Added: v171.

## subscription_canceled
- Fires when: `cancelSubscription` succeeds.
- Must not fire when: a resume, or Stripe ending a subscription for non-payment.
- Read by: Churn reasons.
- Added: v171.

## error_shown
- Fires when: the client renders a server failure to the person (toast or error state).
- Must not fire when: an error nobody saw.
- Read by: Failures that touched users.
- Added: v171.

## sync_failed
- Fires when: a connector sync run ends in failure after retries.
- Must not fire when: a retried-then-recovered run.
- Read by: Sync failure rate.
- Added: v171.

## email_send_failed
- Fires when: an outbox send reaches a terminal failed state.
- Must not fire when: a retry in progress.
- Read by: Email failure rate.
- Added: v171.

## survey_shown
- Fires when: a micro-survey is displayed.
- Must not fire when: it was suppressed by the cadence rule.
- Read by: Survey response rate.
- Added: v171.

## survey_dismissed
- Fires when: the person dismisses a survey.
- Must not fire when: an answer.
- Read by: Survey fatigue.
- Added: v171.

## survey_answered
- Fires when: the person answers a closed question.
- Must not fire when: a free-text note (that goes to `feedback`, never here).
- Read by: Qualitative loop, tied to cohorts.
- Added: v171.

## account_deleted
- Fires when: `deleteOwnAccount` is about to purge; written with `user_id` null.
- Must not fire when: an admin suspension.
- Read by: Churn by tenure and reason.
- Added: v171.

## gate_hit
- Fires when: any plan or allowance gate refuses an action, including managed-credit exhaustion, the background floor and speech caps; recorded in `gate_events` with `context.surface` and `context.route`.
- Must not fire when: the gate allowed the action.
- Read by: the Demand page; last gate before conversion.
- Added: pre-v171 (coverage widened in v171).
