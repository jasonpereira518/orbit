# Cosmo

Cosmo is Orbit's voice assistant: one orb in the corner of every signed-in page that you click
and talk to. It runs on Orbit Voice's providers, **Deepgram by default** (Voice Agent API, a
Deepgram-managed OpenAI model thinks) and **ElevenLabs as an alternative**. Design and the
13-PR history: `docs/superpowers/specs/2026-11-12-cosmo-design.md`.

## What a person sees

- **Idle:** a small aurora orb at the bottom right (toasts and the job stack sit above it,
  through `--orbit-cosmo-height`). It can be dragged or moved with the arrow keys to one of six
  edge slots, steps out of the way of dialogs, focused fields and `data-cosmo-avoid` areas, and
  on a phone tucks into an edge tab while the keyboard is up. Hidden during the guided tour.
- **Nudge chip:** when something is worth a word (a meeting soon, things due, a meeting with no
  note, new on Radar; `src/lib/cosmo/nudge.ts`) the orb glows and shows one chip, dismissable
  for the day. A call started from it opens with that topic, worded by the server.
- **A call:** clicking the orb starts one in the day's Cosmo thread (remembered per device).
  Chat's mic button starts one in the open thread. The call survives navigation: off Chat it
  is the docked bar with cards, errors and optional captions; on Chat, in the call's thread,
  the orb flies into the big stage (`VoicePanel`) and back out when you leave.
- **Seeing and pointing:** Cosmo is told the page, the open record's id and the registered
  controls on screen (`src/lib/cosmo/screen.ts`, labels from `tour-anchors`) — never page text
  or screenshots. On desktop `point_at` flies its labelled cursor to a control and walks the
  steps on your clicks (`src/lib/cosmo/pointing.ts`).
- **Acting:** small changes you ask for apply at once with Undo (`chat-auto-apply` gates, five
  a call, off for the rest of a call once a lookup looks like an injection). Anything outward
  or destructive is a card: on Deepgram Orbit reads it back in its own words and listens for
  the verb ("send it", "delete it") only after the read-back has played
  (`src/lib/voice/confirm-window.ts`); a click works everywhere. Sends go through the outbox,
  so "undo" within ten seconds stops them. The model never has a commit tool.
- **Speaking up mid-call** (Deepgram only): only time-sensitive nudges, never while anyone
  speaks or a confirmation is open, a minute apart, three a call, once a page. "Stop
  interrupting" turns it off on the device.
- **Captions:** off by default; paced by Deepgram's playback (ElevenLabs: a speaking-rate
  estimate). Toggle in the bar or by asking.

## Minutes and limits

- Talk time per plan, per UTC month: Free 10 min, Pro 60, Max and Lifetime 180
  (`speech.assistantSeconds`, changeable under Admin → Product → Plans). Counted from
  `orbit_voice_sessions`: connected to ended, or to the last heartbeat while live, never past
  the call's expiry (`src/lib/voice/minutes.ts`). Never-connected calls are free.
- A call lasts at most ten minutes, cut to what is left of the month and of the **daily
  budget** across all accounts (Admin → Product → Chat, default 600 min). Out of either: the
  start is refused with plan-aware copy. In its last minute the bar says so.
- Starts are an abuse limit only: 30 an hour and 150 a day per account. A call ends after
  60 seconds with no speech either way.
- Admin → Billing → Usage shows Cosmo talk per account and per month.
- Hiding `feature.cosmo` (Admin → Product → Features) is the off switch for the orb, nudges and Cosmo's
  powers (instant changes, pointing, metering); Chat's mic still works as plain Orbit Voice.
  The **Enable Orbit Voice** master switch turns everything off.

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

## Security

- Authentication, suspension and Chat visibility protect every `/api/voice` call; same-origin
  checks, bounded JSON and database rate limits apply first. Deepgram gets a 30-second grant,
  ElevenLabs a private-agent signed URL; provider keys never reach the browser.
- Prompt context is built on the server in Orbit's own words; the browser sends ids, never
  text that is spoken or prompted verbatim (screen ids, the nudge id). CRM records and history
  are labelled untrusted data. A proposal may only touch records a lookup actually returned.
- Live audio is not stored. Transcripts are ordinary messages in the call's Chat thread and
  follow export and deletion. `/privacy` (terms 2026-11-13) describes all of it.
- Orbit cannot revoke an issued provider socket: configure provider-side quotas, concurrency
  limits and billing alerts as the hard spend backstop.
- **Reload trap:** never statically import new modules into `src/lib/voice/{sessions,tools}.ts`
  or the voice route — they sit in every page's server-action graph and a wrong import sends
  next dev into a full-reload loop (e2e `page.goto` ERR_ABORTED). Use `await import()`.

## Verification

Pure smokes: `smoke-cosmo-{placement,screen,pointing,nudge}`, `smoke-caption-pace`,
`smoke-confirm-window`, `smoke-voice-minutes`. DB: `smoke-orbit-voice` (credentials, scopes,
instant apply, taint, minutes). Browser: `e2e/08-orbit-voice.spec.ts` (both SDKs) and
`e2e/10-cosmo.spec.ts` (moving, flight, captions, screen, pointing, spoken confirm, nudges,
last minute). `scripts/eval-voice.ts` validates the 28-case voice test set.

Only a real call proves: how often Deepgram accepts injected lines and echoes them as text
(the spoken-confirm window depends on it), caption sync and latency, echo and false "send it",
a real Gmail send and spoken undo, ElevenLabs alignment, phones, CPU over ten minutes, and
whether interjections feel polite.

References: [Deepgram browser SDK](https://developers.deepgram.com/docs/browser-agent-javascript),
[Voice Agent message flow](https://developers.deepgram.com/docs/voice-agent-message-flow),
[Deepgram grants](https://developers.deepgram.com/reference/auth/grant),
[ElevenLabs React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react).
