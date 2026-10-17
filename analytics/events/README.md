# Event ownership document (draft)

One section per event in `analytics/schema/events.ts`. Owner for every event: the founder. A smoke test should assert that every key in `eventSchemas` has a section here and vice versa.

Format per event: **fires when** / **must not fire when** / **properties** / **read by** / **added**.

## capture_saved
- Fires when: `saveCaptureJob` (src/actions/capture-jobs.ts) commits a batch with ≥0 people; once per job.
- Must not fire when: the job is discarded, or a retry of an already-saved job (deterministic id = job id).
- Properties: capture_job_id, source_kind, people_created, people_updated, duration_ms.
- Read by: activation (F9), depth, post-first-capture survey trigger.
- Added: proposed.

## followup_set
- Fires when: a reminder is created by the user (`createReminderForUser`, `scheduleContactFollowUpForUser`, `scheduleFromSuggestion`).
- Must not fire when: Orbit generates a *suggested* reminder the user has not accepted; calendar-sync reminders.
- Properties: reminder_id, origin, has_due_date.
- Read by: activation half 2 (F10).

## followup_completed
- Fires when: `markReminderDone`, `completeFollowUpWithTouch`, each reminder in `bulkReminderAction`; alongside the new `reminders.completed_at` column.
- Must not fire when: a reminder is dismissed or deleted.
- Properties: reminder_id, days_late (negative when early), via.
- Read by: value metric (§2.5), F11, follow-up survey trigger.

## ai_key_added
- Fires when: `applyAiKeyChange` turns an absent key into a present one for any provider.
- Must not fire when: a key is replaced, cleared, or re-saved unchanged.
- Properties: provider, plan, seconds_since_signup.
- Read by: F8 (AI ready), first-cliff tile.

## mcp_tool_called
- Fires when: `runTool` finishes for any MCP tool, including refusals (ok=false).
- Must not fire when: the request failed authentication (no user).
- Properties: tool, client, ok, duration_ms, result_count.
- Read by: MCP first call, weekly return, WAN.

## checkout_started
- Fires when: `startSubscriptionCheckout`, `startCreditPackCheckout`, Lifetime checkout creation succeeds (a Stripe session exists).
- Must not fire when: the gate refused before a session was created (that is `gate_hit`).
- Properties: plan, interval, from_gate.
- Read by: F15 funnel, gate → upgrade, abandonment.

## gate_hit (existing table `gate_events`)
- Fires when: any plan or allowance gate refuses an action, including managed-credit exhaustion, background floor, speech caps (proposed additions).
- Must not fire when: the gate allowed the action.
- Properties: feature, plan, unlock_plan, context.surface, context.route.
- Read by: demand page, last gate before conversion.

(Remaining events follow the same template; fill in as each is implemented.)
