# Cosmo design (approved Nov 12, 2026)

## Context

Orbit Voice today is a call bound to one Chat thread. It starts only from Chat's composer,
shows a large stage in Chat and a small pill at the middle-right elsewhere, cannot apply or
send anything itself, has no captions outside Chat, does not know which screen you are on,
and is neither metered nor plan-gated.

Jason wants it to become **Cosmo**: one assistant on every signed-in screen at the
bottom-right, that you click and talk to, that knows everything Orbit knows, takes actions
(including sending), moves smoothly so nothing covers it, points at things with its own
cursor, shows captions on request, speaks up when something matters, and feels smart.

### Decisions Jason made (Nov 12, 2026)

| Topic | Decision |
|---|---|
| Name | Cosmo |
| Speaking up | Idle orb glows with a one-line chip. On click it opens with what matters for the current screen. During a live call it may also interject on its own. |
| Confirmation | Tiered. Small reversible in-app changes apply at once with Undo. Outward or destructive changes are read back and wait for a spoken confirmation or a click, then a short undo window. |
| Mobile | Orb, voice, captions and actions on every screen size. The pointer cursor is desktop-first. |
| Brain | Keep the provider-hosted model, upgrade it and its context, score it on a test set. Build Orbit's own brain endpoint only if the tests show the model is the limit. |
| Chat page | With a live call the orb animates into the big centred stage on Chat and back to the side when leaving. The conversation continues across pages. |
| Access | Everyone, voice minutes metered by plan. |

### Calls I made (correct any of these at approval)

1. User-facing name is Cosmo everywhere; code keeps the `voice` module names.
2. Cosmo acts through tools, never by clicking the UI for you. The cursor only shows.
3. Screen awareness is registry ids and labels, the page key and the record id. Never DOM
   text or screenshots (that would be a prompt-injection path and a privacy leak).
4. Write tiers stay exactly as Chat defines them (`tier`, `destructive` on each write).
   `create_meeting` stays instant: it only touches your own calendar and has Undo.
5. The orb rests in one of six slots (top, middle, bottom on the left or right edge). You
   drag it and it snaps to the nearest; bottom-right is the default home.
6. Calls started from the orb use one Cosmo thread per day, remembered per device. Chat's
   mic button talks in the open thread.
7. Captions default off. Captions, home slot and dismissed nudges are per-device
   (`orbit:` localStorage keys), like the other UI preferences.
8. Spoken confirmation and interjections are Deepgram-only (production's provider).
   ElevenLabs cannot speak a fixed line, so there it is click-to-confirm and no interjections.
9. Cosmo is hidden while the guided tour runs (same corners, tour rail sits above).
10. Starting allowances (worst-case cost at Deepgram's Standard rate of about $0.075/min,
    to be checked against the pricing page): Free 10 min/month ($0.75), Pro 60 ($4.50),
    Max 180 ($13.50), Lifetime 180. Tunable in the admin plan rules.

### Non-goals

Wake word or always-listening. Cosmo clicking or typing in the UI. Replacing the ask bar or
typed Chat. Merging duplicates by voice (no merge tool exists; Cosmo can open the page and
point). Other languages. Orbit's own brain endpoint, unless PR 8's test set calls for it.

## How Cosmo behaves

```
Idle, any page            Live, docked                         Live, on Chat (call's thread)
                          ┌ caption (optional) ───────────┐    ┌──────────────────────────┐
              toasts      │ "Coffee with Ada at three…"   │    │        ( big orb )        │
              jobs        └───────────────────────────────┘    │   transcript · cards      │
   chip ▸ ( o )           [ Email Ada · Send · Dismiss ]       │   mute · captions · end   │
                          ( O )  mute · cc · chat · end        └──────────────────────────┘
```

- **Idle:** a small aurora orb at the bottom of the corner column. Toasts and the job
  widget stack above it. A chip appears beside it when something matters.
- **Click:** the call starts and Cosmo opens with the most useful line for this screen.
  Click again, or stay silent for a minute, and it goes back to idle. The next click
  resumes the same thread.
- **Tray:** cards waiting for confirmation, Undo chips, errors and captions show beside the
  orb on every page (today cards only show in Chat).
- **Moving:** it slides out of the way of dialogs, focused fields and page rails, flies
  into Chat's stage, and glides near whatever it is pointing at.
- **Pointing:** a Cosmo-labelled aurora cursor flies from the orb to a control and rings
  it. You click; Cosmo moves to the next step.

## Architecture

**1. Split the engine from the view.** `voice-panel.tsx` mixes the call engine and its UI.
The engine (session start and stop, timers, transcript saves, provider adapters, tool
dispatch, cards) moves to a headless component in the app layout that writes to one store.
The orb, tray, captions, Chat stage and cursor are plain views over that store. The
detached-host trick in `voice-dock.tsx` is no longer needed.

**2. One orb, three placements.** A single fixed element whose target rectangle is its dock
slot, Chat's stage slot, or a spot near a pointing target. It moves with transform springs
and sets its real canvas size once at rest. Idle is CSS only; the canvas mounts only during
a call and pauses when the tab is hidden.

**3. The corner column does the stacking.** At bottom-right Cosmo publishes
`--orbit-cosmo-height`, and the job stack and toasts add it to their offsets, the same way
`--orbit-job-stack-height` works today. Pages that lift the corner lift Cosmo too.

**4. Two channels to the model.** `say(text)` speaks a fixed line (read-backs, openers,
interjections). `sendContext(text)` is silent. Today Deepgram's `sendContext` calls
`injectAgentMessage`, which speaks the text aloud: a live bug that PR 1 fixes. Silent
context rides on every tool result (`screen` and `app_events`), so it does not depend on
unverified provider behaviour.

| Capability | Deepgram | ElevenLabs |
|---|---|---|
| Speak a fixed line | `injectAgentMessage(text, behavior)` | not available |
| Silent context | tool-result piggyback; `updatePrompt` only after a real-call check | `sendContextualUpdate` plus piggyback |
| Opener | `greeting` setting | `first_message` override (agent must be re-provisioned) |
| Caption timing | PCM bytes ÷ 48,000 and `getRemainingPlaybackTime()` | `onAudioAlignment` |

**5. Actions are gated by app code, never by the model.**
- Instant tier: the existing `shouldAutoApply` gates, with voice passing `enabled: true`,
  requiring `asked_for`, a per-session cap, and a sticky taint flag that turns instant
  apply off for the rest of a session once any tool result shows injection signals.
- Confirm tier: the client reads the stored proposal back with `say()` from a template
  (the model's own description is never what gets confirmed), then opens a window bound to
  that proposal. Only a whole-utterance match on a short phrase list counts, the utterance
  must start after the read-back finished playing, sends and deletes need their verb
  ("send it", "delete it"), one pending proposal at a time, and the window closes on any
  other utterance or after 30 seconds. The model never gets a commit tool.
- Sending goes through the existing outbox, so the 10-second undo applies. Saying "undo"
  cancels it.

## What gets reused

| Need | Existing code |
|---|---|
| Call, providers, session rules | `src/components/chat/voice-panel.tsx`, `voice/deepgram-adapter.tsx`, `voice/elevenlabs-adapter.tsx`, `src/lib/voice/{contracts,sessions,tools,policy,settings}.ts`, `src/app/api/voice/route.ts` |
| Orb | `voice/voice-orbit.tsx`, `src/lib/voice/visual-level.ts` (`orbParams`) |
| Corner stacking | `src/app/theme.css` corner variables, `src/lib/corner-clearance.ts`, `jobs/global-job-progress-bar.tsx` |
| Pointing | `tour/tour-cursor.tsx`, `tour/tour-spotlight.tsx`, `src/lib/tour/tour-anchors.ts`, `use-anchor-rect.ts` (`useSelectorRect`), nav-link and scroll logic in `tour/tour-runtime.tsx`, `scripts/smoke-tour-stops.ts` |
| Placement | `overlapArea` in `src/lib/tour/rail-placement.ts`, `src/lib/overlay-open.ts` |
| Motion | `motion/react` drag and springs, `src/lib/motion.ts`, `use-prefers-reduced-motion.ts` |
| Stores | `src/lib/create-external-store.ts` |
| Tiered writes | `src/lib/chat-auto-apply.ts`, `src/lib/tools/chat-writes*.ts`, `commitProposedAction` and `undoProposedAction` in `src/actions/chat-actions.ts`, `chat/proposed-actions.tsx` |
| Sending | `getChatSendContext` and `sendChatDraftViaGmail` (`src/actions/chat-send.ts`), `cancelEmailSend` (`src/lib/email/outbox.ts`), `getSendCapability` (`src/lib/email/sender.ts`) |
| Proactive data | `src/lib/app-pulse.ts`, `app-pulse-store.ts`, `renderAttentionLite` (`src/lib/chat-attention.ts`) |
| Metering | `orbit_voice_sessions` timestamps, `monthWindow` and `quotaState` in `speech-quota.ts`, `plans/plan-config.ts` |
| Shipping dark | `FEATURES` in `src/lib/surfaces.ts`, `surface-visibility.ts` |
| Evals | `scripts/eval-ai.ts`, `scripts/eval-fixtures` |

## PR sequence

Every PR merges to main behind `feature.cosmo` (hidden for users, on for localhost and the
preview cookie) and is verifiable alone. No new routes: everything goes through
`/api/voice` (maxDuration 60), so the 12-function cap is untouched. No CSP change. Schema
changes only in PR 9; rescan the schema version right before that commit.

### PR 1. Engine split and the spoken-context fix (no flag, no visible change)
- New `src/lib/voice/call-store.ts` and `src/components/chat/voice/voice-engine.tsx`
  holding what is now `voice-panel.tsx` lines 93 to 454. `VoicePanel` becomes a view.
- `contracts.ts`: `sendContext` is silent, `say` is optional. Deepgram stops speaking
  card-confirmation notes; they queue as `app_events` on the next tool result.
- Proof: `e2e/08-orbit-voice.spec.ts` passes unchanged, plus an assertion that no
  `InjectAgentMessage` frame is sent when a card is confirmed. `smoke-orbit-voice` passes.

### PR 2. Cosmo shell: flag, idle orb, click to talk, tray
- `feature.cosmo` in `surfaces.ts`; the app layout mounts `CosmoRoot` or `VoiceDock`.
- New `src/components/cosmo/cosmo-root.tsx`: CSS-only idle orb as a real button, live
  canvas orb, controls (mute, open chat, end), tray with `ProposedActionsCard`, errors and
  the unsaved-transcript state. Root carries `aria-live="off"` so Base UI modals do not hide it.
- `theme.css`: `--orbit-cosmo-height` in the job stack and toast offsets; honours corner
  shift and dock width.
- App pulse carries the voice public state (no second poll). Day thread in localStorage.
- Cosmo persona, greeting and labels when the flag is on.
- Proof: new `e2e/10-cosmo.spec.ts`: start from the dashboard, the call survives
  navigation with one socket, toasts never intersect the orb. Spec 08 pins the flag off.

### PR 3. Chat stage flight
- `chat-panel.tsx` gets a `data-cosmo-stage` slot, shown only when the call's thread is the
  open thread (today the stage shows under any thread, and the composer and `ask_chat`
  can write to different threads).
- The orb flies between dock and stage using `useSelectorRect` and `SPRING_SOFT`; z-index
  by mode (stage below page menus, dock above dialogs); reduced motion crossfades.
- Proof: e2e keeps one socket across Chat and other pages; opening another thread docks the orb.

### PR 4. Moving: drag, slots, dodging, mobile
- New pure `src/lib/cosmo/placement.ts`: six slots, least overlap against open dialogs,
  sheets and popovers, the focused field, page rails, the feedback panel and anything
  marked `data-cosmo-avoid`. Re-solves on focus, resize and overlay changes only, with
  300 ms hysteresis, never while hovered or dragged.
- `motion` drag with snap-to-slot, home slot persisted, a keyboard "move to other side".
- Mobile: docks above the bottom nav, follows `visualViewport`, collapses to an edge tab
  while a field is focused. Hidden during the guided tour.
- `data-cosmo-avoid` on Capture's Accept row and the constellation controls.
- Proof: new `scripts/smoke-cosmo-placement.ts`; e2e at 390×844; with a modal open, an orb
  click leaves the dialog open and the orb is not `aria-hidden`.

### PR 5. Captions
- New pure `src/lib/voice/caption-pace.ts`; `onCaption` in the contract; Deepgram duration
  from PCM bytes, ElevenLabs from `onAudioAlignment`.
- Caption bubble beside the orb (two lines, not a live region), cut on interruption, your
  last line shown dimmed. Toggle in the controls and a `set_captions` browser tool.
- Proof: pacing smoke; e2e with mocked audio shows progressive reveal and the cut.

### PR 6. Seeing: screen awareness
- New `src/lib/cosmo/screen.ts`: page key, record id and the visible anchors' ids and labels.
- `tour-anchors.ts` gains a label and page per anchor, plus about 25 new anchors on primary
  actions (new reminder, add contact, send email, log interaction, capture drop,
  integrations and so on). Nav links are found by `href` as the tour does.
- The start request carries the screen; every tool result carries `screen` and
  `app_events`; new `look_at_screen` browser tool.
- Proof: `smoke-tour-stops` extended to labels; prompt-budget assertion; e2e shows the new
  page on the next tool result after navigating.

### PR 7. Pointing: Cosmo's cursor
- `TourCursor` gets `label` and `tone` props (aurora, "Cosmo"); spotlight ring without the scrim.
- New `point_at({targets})` browser tool taking registry ids only. It returns at once; a
  client-side guide walks the steps on your clicks, adds the sidebar link first when the
  target is on another page, scrolls it into view, and reports clicks as `app_events`.
  On Deepgram it speaks a short templated cue between steps.
- The orb glides to the free slot nearest the target and goes home afterwards.
- Desktop only. Elsewhere the tool answers "describe it instead" and `open_page` still works.
- One polite "Pointing at X" for screen readers; the cursor itself is `aria-hidden`.
- Proof: e2e points across pages and follows a click; reduced motion jumps instead of flying.

### PR 8. Knowing: data, context, model, test set
- New shared read tools in `src/lib/tools/definitions-features.ts` for the gaps: email
  inbox and thread (email-intel store, consent-gated), Radar briefing
  (`loadRadarBriefing`), people to meet (`loadPeopleToMeet`), what needs attention
  (`loadNotificationPanel`), integration status (`listConnectorConnections`). Chat and MCP
  get them too.
- `voiceInstructions`: Cosmo persona, your name, role and goals, the attention brief, and
  "show, don't recite" (a list longer than three opens the filtered page and gets a
  one-sentence summary). Per-section caps; a smoke asserts the worst case stays under 24,000.
- `DEEPGRAM_THINK_MODELS` extended to the current managed list, with the pricing tier shown
  in admin.
- A voice task in `scripts/eval-ai.ts` with about 40 text-level cases: tool choice,
  grounding, resolving "her" and "this" from the screen, and refusing injected instructions.
  The default model is picked from this report, and it decides whether PR 14 is needed.

### PR 9. Acting I: instant changes with Undo (schema)
- `callVoiceTool` runs the auto-apply gate as described in Architecture 5 and applies
  before inserting the card, so a click cannot race it.
- DDL: `orbit_voice_sessions.tainted_by` and `auto_applied`, plus the version bump.
- Tray shows done cards with Undo (`undoProposedAction`). Each applied change records a
  security event.
- Proof: smoke covers applied, confirm-tier untouched, tainted session, and the cap.

### PR 10. Acting II: spoken confirmation and sending
- New pure `src/lib/voice/confirm-window.ts` implementing the confirm-tier rules.
- Send path: `getChatSendContext`, then `sendChatDraftViaGmail`, then the undo toast and a
  spoken "undo" that calls `cancelEmailSend`. `guardVoiceProposal` is added to the send
  action (the voice kill switch is not enforced there today). Optional `subject` on `draft_email`.
- No mailbox connected: Cosmo says so and points at Settings, Integrations.
- Proof: state-machine smoke; e2e shows an early "send it" is ignored, a late one queues
  the email, and "undo" cancels it.

### PR 11. Speaking up: nudges, opener, interjections
- New pure `src/lib/cosmo/nudge.ts` over the app pulse: meeting within 20 minutes, overdue
  or due today, unlogged meeting, a card waiting, new on Radar. One chip, dismissed per day.
- Opener templated server-side in `startVoiceSession` from the pulse and the screen.
  ElevenLabs gets the `first_message` override (`agent-config.ts`, `isSafeVoiceAgent`,
  re-run `scripts/setup-orbit-voice.ts`).
- Interjections on Deepgram with a policy: nobody speaking, no confirmation open, at least
  60 seconds apart, at most three per call, once per page. "Stop interrupting" and a
  Settings toggle turn them off.
- Proof: smoke table for ranking and policy; e2e checks the chip and the greeting frame.

### PR 12. Metering, caps, auto-sleep
- `speech.assistantSeconds` in `plan-config.ts`, plan overrides, the admin rules panel and
  plan copy. Usage is summed from `orbit_voice_sessions`, so no new table.
- Refuse at start with plan-aware copy; `expiresAt` is the smaller of 600 seconds and the
  minutes left; the heartbeat returns what remains and the orb shows it near the end.
- Start caps become an abuse limit (about 30 an hour) and the global cap becomes a daily
  minute budget set in admin. Calls end after 60 seconds without speech.
- A usage row in Settings, Plan and usage; cost rows in the admin view.
- Proof: smoke for exhausted and partial allowances; e2e for the refusal copy.

### PR 13. Launch
- Drop `comingSoon` on `feature.cosmo`. Delete `VoiceDock`, the host trick, the compact
  pill and the composer's status poll. Chat's mic button wakes Cosmo in the open thread.
- `/privacy` and `legal.ts` (screen context sent to the voice provider; terms version
  bump), `docs/orbit-voice.md` rewritten as `docs/cosmo.md`, an onboarding tip, admin labels.

### PR 14 (only if PR 8's test set says so). Orbit's own brain
An OpenAI-compatible think endpoint under `/api/voice` with a per-session bearer token,
running `answerWithLookups` on a fast voice lane through `ai-access.ts`. Needs a preview
protection bypass and a latency budget, which is why it is not the starting point.

## Verification

Per PR, in this order:

```bash
npm run typecheck
npm run lint
npx tsx scripts/smoke-orbit-voice.ts
npm run test:smoke
npx playwright test e2e/08-orbit-voice.spec.ts e2e/10-cosmo.spec.ts
```

- Visual states (orb modes, captions, cursor flight, slots) on a bench page,
  `src/app/bench/cosmo/page.bench.tsx` with `ORBIT_BENCH=1`, driven by fake levels.
- Screens checked with Playwright and system Chrome at desktop and 390×844, in light and
  dark and with reduced motion. A hidden preview pane never hydrates, so it is not evidence.
- Stop `next dev` before `next build`; rerun a flaky smoke alone before believing it.

### Only a real call can prove (Jason, on a preview deploy)

1. Deepgram `updatePrompt`: replace or append, and whether it interrupts speech.
2. `injectAgentMessage`: how often it is refused, and whether the line comes back as transcript text.
3. Caption sync, and latency with the larger model and the full prompt.
4. Echo on speakers; false accepts and rejects of "send it".
5. A real Gmail send and a spoken undo inside 10 seconds.
6. ElevenLabs: first-message override accepted, alignment events firing.
7. iPhone and Android: mic permission from an orb tap, audio across navigation and
   backgrounding, the keyboard and bottom nav.
8. CPU and battery over a 10-minute call; whether interjections feel polite.

