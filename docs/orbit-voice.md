# Orbit Voice

Orbit Voice is a real-time conversational CRM assistant with **Deepgram as the default**
and **ElevenLabs as an alternative**. It is off by default, including for administrators.
Text chat retains its existing providers and behavior.

## Voice in Chat

When the composer is empty, its right button starts Orbit Voice. Typing changes it to
Send; the keyboard up-arrow shortcut still recalls the last message. The separate microphone
continues to dictate into the text box. Voice opens a centered overlay and starts connecting
immediately, with mute, end, an optional live transcript, and confirmation cards.

Gold outer rings respond to microphone audio; the teal (light theme) or ice-blue (dark theme)
planet responds to actual reply playback. Reduced motion keeps the shape still and uses
intensity plus status text. End conversation or Escape releases the microphone, saves pending
turns, closes the overlay, and returns to the composer. Backdrop clicks do not end a call.

Voice reuses the current thread, or creates one if Chat is new. Recent thread messages and
the conversation context note are read on the server. Finalized transcript turns save
incrementally; retries and interruption corrections update the same message. Interrupted
replies are marked in history. Unsaved turns remain in the overlay with a retry control.
Transcript cleanup writes remain available for five minutes after the session expires.

## Deployment and setup

1. Run `npm ci` and deploy using Orbit's normal guarded `npm run db:migrate` flow.
   Schema 221 introduces voice leases; schema 222 adds runtime provider configuration,
   credential health and connection usage. Fresh settings select Deepgram with voice off.
   Existing enabled ElevenLabs configurations retain their provider on upgrade. No CRM
   data is rewritten. Do not point local/preview migrations at production.
2. For Deepgram, configure the existing server-only `DEEPGRAM_API_KEY`. It needs permission
   to mint grants and access the Voice Agent API, including Deepgram-managed LLMs. The
   existing `ORBIT_DEEPGRAM=off` deployment kill switch also disables this voice provider.
   No additional OpenAI key is needed: the managed think stage is billed through Deepgram.
   Review project privacy, recording and Model Improvement Program settings before rollout;
   configure project-level opt-out where required. Do not use the early-access Think-Fast
   models for production. This integration uses supported managed OpenAI models instead.
3. For ElevenLabs, configure server-only `ELEVENLABS_API_KEY`. Review the configuration
   printed by `npx tsx scripts/setup-orbit-voice.ts`; add `--create` to provision a new client
   tool and private agent. Save the returned `ELEVENLABS_AGENT_ID`. The script uses the
   current tool_ids API and enables system-prompt, TTS model and voice overrides.
   Restricted keys need agent/tool read/create and signed-conversation URL permissions.
   Existing private agents must enable those overrides to use the corresponding settings.
   The template disables voice recording and requests one-day retention; review this in
   ElevenLabs before rollout. No CRM knowledge is uploaded into a shared knowledge base.
4. Open **Admin → Product → Chat**. Choose the provider and its supported voice/models,
   save, check provider credentials, then enable Orbit Voice. API keys stay in the server
   environment; the admin form never accepts or returns secrets.

Changing provider, voice, models, fallback, or the master toggle requires no redeployment.
A configuration change invalidates old leases and confirmation cards. Open clients stop
within 15 seconds and require a new conversation; a call never silently moves providers.
Saving model settings cannot overwrite a concurrent master-disable action.

## Admin controls and status

- **Enable Orbit Voice** is the master switch. Off prevents session issuance, tool access
  and voice-card commits, and disables the composer’s voice entry. Cleanup remains allowed.
- **Voice provider** defaults to Deepgram. Server-side selection is authoritative: clients
  cannot supply arbitrary provider names or endpoints.
- Deepgram settings include Nova-3/Nova-2 listening, gpt-4o-mini/gpt-4o managed conversation
  models, and a bounded Aura-2 voice selection. ElevenLabs supports Flash/Turbo v2.5 speech
  models and an optional voice ID belonging to the configured account.
- **Fallback behavior** defaults to retrying the selected provider only. With “Offer
  alternative after a failure”, a configured alternative becomes a separate user button.
  No failed API call, lost socket, or reconnect automatically transmits audio to another
  provider. Both attempts consume the same start budgets. Recent transcript turns are
  bounded and passed as untrusted context; CRM records must be looked up again.
- **Provider status** distinguishes missing credentials, unchecked configuration, credential
  validation and failed connections. Checks mint/discard a short-lived credential and
  inspect private-agent configuration; they do not start a paid audio call or prove that
  every voice/model connection will succeed. Failure bodies and secrets are never stored.
- **Last 24 hours** shows provider-specific starts, failures, tool calls and estimated
  connected minutes. Connection timestamps are server-written after a client reports its
  SDK ready. These are operational estimates, not provider billing reconciliation.

## Shared CRM intelligence and confirmation

Both transports use the same server-generated instructions, tool catalog and Zod schemas.
The authenticated Clerk identity scopes every read and write. Read tools cover contacts,
relationships, notes, timelines, stored AI summaries, meetings, tasks and follow-ups. The
assistant can search a network, prepare for meetings, log interactions, create or complete
reminders/tasks, update contacts and draft follow-up wording.

Changes become the existing stored chat proposal cards. They never auto-apply, even when
text-chat auto-apply is enabled. A person must read and click the card; spoken assent and
model-provided approval fields cannot commit anything. The existing compare-and-swap commit
path ensures a double click writes once. There is no sending tool; communications remain
in Orbit's normal compose/send approval flows. IDs become eligible for a proposal only
when an authorized lookup actually returned them, including the response-size limit.

The browser uses a small shared controls/events contract. Provider adapters own only SDK
connection, audio, transcript events and function-response differences. Deepgram streams
PCM through its Voice Agent API, stops queued playback on UserStartedSpeaking, and defers
CRM function calls until the user finishes their turn. ElevenLabs uses its React SDK and
corrects interrupted transcripts. Both expose mute/end controls, permission recovery,
connection timeouts, transcript scrolling, and explicit recovery. SDKs load only when used;
transport errors cannot take down the text-chat panel.

## Security, costs and lifecycle

- Authentication, account suspension and Chat visibility/plan checks protect every route.
  Same-origin checks, bounded JSON input and database rate limits apply before execution.
  The bridge never sends emails, approves drafts, runs arbitrary MCP tools or fetches a
  model-selected URL. CRM records and transcript history are untrusted data in the prompt.
- Deepgram credentials reuse `mintStreamToken` in `src/lib/deepgram.ts`: only a 30-second
  bearer grant reaches the browser. ElevenLabs receives a private-agent signed URL. Raw
  provider keys never reach browser bundles, transcripts, logs or admin responses.
- Orbit leases last ten minutes and allow 60 tool calls. Starts are limited to three per
  account/hour, six per account/day and 100 Orbit-wide/day, including failed starts and
  fallback attempts. There are no silent or unbounded reconnect loops.
- An already-issued vendor capability cannot be revoked by Orbit, and socket authentication
  outlives token expiry. The app closes at lease expiry or disable, and the server rejects
  further CRM reads and voice-originated commits. A modified client can keep a provider
  socket alive: Deepgram's provider maximum is two hours, whereas the ElevenLabs template
  sets 600 seconds, 100 daily calls and five concurrent calls with bursting disabled.
  Configure provider-side project quotas/concurrency limits and billing alerts as a hard
  spend backstop. App limits are not a dollar ledger or a provider-side socket revocation.
- Relevant CRM context is retrieved on demand; the whole account is never uploaded.
  Orbit does not persist live audio. Finalized transcripts are stored as ordinary messages
  in the current Chat thread. Transcripts, session metadata and confirmed/pending proposal
  cards follow the existing account export and deletion lifecycle.
- The disabled flag is checked uncached, including during provider preflight and before/
  after tool execution. A late result from an old call cannot affect a replacement call.
  Settings changes invalidate leases across serverless instances. Secrets are deployment
  configuration; provider choices and supported models are database configuration.

## Verification

`npx tsx scripts/smoke-orbit-voice.ts` uses disposable PGlite and mocked provider responses.
It covers both credentials, shared CRM/AI knowledge, isolation, stored confirmation and
exactly-once commit, provider switching, explicit/forbidden fallback, missing credentials,
size and usage limits, disabled states, preflight races, failed health/usage and concurrent
admin updates. Existing export/deletion and DDL checks include voice metadata.

`e2e/08-orbit-voice.spec.ts` uses the actual browser SDKs with simulated microphone input
and intercepted provider WebSockets. It exercises both protocols, streaming transcripts,
playback interruption, tool responses, mute/end, live disable, mobile layout, permissions,
explicit fallback and persistent admin selection. No real provider key or paid call is
needed. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and the relevant
browser tests before review.

A paid end-to-end voice test still requires configured provider accounts. Before rollout,
verify a spoken CRM lookup and confirmed reminder with each provider, switch providers
from a second admin window, test a network interruption and explicit fallback, and inspect
actual usage and privacy settings in both provider consoles.

References: [Deepgram browser SDK](https://developers.deepgram.com/docs/browser-agent-javascript),
[Voice Agent message flow](https://developers.deepgram.com/docs/voice-agent-message-flow),
[Deepgram grants](https://developers.deepgram.com/reference/auth/grant),
[ElevenLabs React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react).
