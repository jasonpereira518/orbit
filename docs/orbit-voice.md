# Orbit Voice

Orbit Voice uses ElevenAgents with `@elevenlabs/react`. It is **off by default**, including
for administrators. Text chat uses its existing routes, providers and settings.

## Setup

1. Install dependencies with `npm ci`. Configure the server-only `ELEVENLABS_API_KEY`.
   Use a restricted ElevenLabs key with agent/tool read/create and conversation signed-URL permissions.
2. Review `npx tsx scripts/setup-orbit-voice.ts` (prints the proposed configuration without
   making a provider request). Run `npx tsx scripts/setup-orbit-voice.ts --create` to provision
   a blocking client tool and a new private agent, then set the returned `ELEVENLABS_AGENT_ID` in the server environment.
   This does not enable voice or modify an existing agent.
3. Review the agent's voice, language, privacy/retention and allowed domains in ElevenLabs.
   The template disables audio recording and sets one-day retention. No account knowledge is
   uploaded to a shared agent knowledge base. Relevant CRM records are transmitted only as
   tool results during a conversation. Provider retention is controlled in ElevenLabs.
4. Run `npm run db:migrate` against the intended database using Orbit's usual deployment
   migration safeguards. Schema 221 adds two settings columns and `orbit_voice_sessions`;
   no existing CRM rows change. Do not run a local preview migration against production.
5. Open **Admin → Product → Chat** and turn **Orbit Voice** on. No redeploy is needed to
   change this setting once credentials and schema are deployed.

The application verifies the private agent has authentication enabled, a maximum duration
of at most 600 seconds, prompt overrides enabled and the blocking `orbit_tool` client tool.
Keep the agent configuration aligned with `src/lib/voice/agent-config.ts`. The catalog in
the session prompt is generated from Orbit's real Zod schemas. The template uses a low-cost
model and Flash speech synthesis; choose alternatives in ElevenLabs as needed.

## User experience

In Chat, choose **Talk to Orbit**, then **Start conversation** to grant microphone access.
The panel shows listening/speaking status, live transcripts, mute and end-call controls.
Users can interrupt spoken answers. Transcript corrections replace interrupted responses.
Voice and text chat can be used independently. The SDK is loaded only when voice is opened.

Try “Who do I know at Acme?”, “Help me prepare for my meeting with Ada”, “What do I owe
people this week?”, “Log that Ada and I discussed the launch”, or “Remind me to follow up
with Ada next Tuesday”. The assistant looks up real records and can summarize existing AI
knowledge. Follow-up wording can be drafted conversationally; no tool sends a message.

Writes create the same stored proposal cards used by text chat. They never auto-apply,
even when the user's text-chat auto-apply preference is on. Users must read and click the
card. Spoken assent cannot commit a change. Proposals appear in chat history under
“Orbit Voice”; audio and the live transcript are not persisted by Orbit.

## Security and operation

- Clerk authentication, account suspension and Chat visibility/plan gates protect every
  route. Identity always comes from the session, never a request argument or model tool.
- Cookie routes enforce same-origin requests, bounded JSON bodies and database rate limits.
  Only allowlisted, released read tools and proposers run. The shared registry validates
  arguments and scopes reads to the caller. IDs for writes must have been returned by
  server-side lookups in this voice session. External web research and sends are excluded.
- Sessions expire after ten minutes and allow 60 tool calls. Starts are capped at three
  per account/hour, six per account/day and 100 Orbit-wide/day. These are separate voice
  budgets, enforced in Postgres across serverless instances. Failed starts consume an
  attempt to prevent retry abuse. ElevenLabs also caps calls at 100/day and five concurrent
  conversations with bursting disabled. These are usage limits, not a dollar spend ledger;
  monitor actual costs in ElevenLabs.
- The database toggle is read uncached before minting and before/after each tool. Turning
  it off blocks new credentials, tool access and confirmations of voice-originated cards.
  A settings generation timestamp prevents old sessions/cards becoming valid on re-enable.
  Already open chat pages hide voice within 15 seconds and end active connections. Cleanup
  remains allowed while off. Text proposals and chat are unaffected.
- ElevenLabs signed URLs are short-lived bearer capabilities: Orbit cannot revoke a URL
  already issued to a browser. An existing vendor connection may finish a spoken answer
  until the application disconnects. Even a modified client cannot retrieve further CRM
  context or commit a voice proposal while disabled. Provider-side duration/daily limits
  bound direct re-use; disabling the agent in ElevenLabs is the provider emergency stop.
- Connection failures never expose the vendor key, raw provider error body or CRM records
  in logs. No key has a `NEXT_PUBLIC_` prefix. CSP allows only the ElevenLabs HTTPS/WSS
  endpoint in addition to existing origins.

## Verification

`npx tsx scripts/smoke-orbit-voice.ts` uses a disposable local PGlite database and mocked
ElevenLabs responses. It covers default-off and missing-key behavior, enabled reads,
account isolation, proposal-only writes and exactly-once confirmation, disabled starts /
tools / direct confirmation, text-chat independence, expiration, budgets and unsafe agents.
The mocked SDK browser flow lives in `e2e/08-orbit-voice.spec.ts` and exercises actual SDK connection setup, transcripts, interruption correction, tool callbacks, mute, end-call and disable teardown without a provider connection.
Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` before review.

A live microphone test requires configured ElevenLabs credentials and an administrator
explicitly enabling the feature. On desktop and phone, verify interruption, transcript
correction, permission denial, reconnect, mute, end, navigation cleanup, confirmation cards,
and disabling from a second admin window. Confirm the provider duration and daily limits.

References: [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react),
[agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication),
[client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools),
[create agent](https://elevenlabs.io/docs/api-reference/agents/create).
