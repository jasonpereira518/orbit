# Cosmo PR 1: engine split and silent context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the Orbit Voice call engine out of `VoicePanel` into a headless component plus a store, and stop Deepgram from speaking context notes aloud. No visible change.

**Architecture:** `VoiceEngine` (headless, rendered by `VoiceDock` outside the portal so moving the view can never hang up) owns the session, adapters, timers, transcript saves and tool dispatch, and publishes a snapshot through `call-store.ts`. `VoicePanel` becomes a view that reads the snapshot and calls store actions. Context for the model is silent: providers with a native silent channel use it; otherwise notes queue in the engine and ride on the next tool result as `app_events`.

**Tech Stack:** React 19 client components, `useSyncExternalStore` via `src/lib/create-external-store.ts`, `@deepgram/agents`, `@elevenlabs/react`, Playwright e2e, tsx smokes.

**Spec:** `docs/superpowers/specs/2026-11-12-cosmo-design.md` (PR 1)

## Global Constraints

- No new routes, no `maxDuration` change, no schema change, no CSP change.
- The adapters must never receive a new `events` object mid-call (the `stableEvents` rule): a reconnect is a new conversation.
- One live call at a time (`openVoice` ignores a second open).
- User-visible copy is unchanged in this PR.

## Review Focus

1. Navigating between Chat and another page mid-call: one provider socket, transcript and cards intact (e2e 08 `sockets === 1`).
2. A card confirmed with no later tool call: the note is not spoken and not lost; it rides on the next tool result.
3. A tool result that is not JSON (or is a JSON array): `app_events` still arrive, the original result survives.
4. Ending the call from the view while transcript turns are unsaved: close is refused and "Retry saving" works (existing e2e).
5. The panel view unmounting and remounting while the engine lives (dock ↔ Chat): no restart, no duplicate `start`.

---

### Task 1: Silent context and `app_events`

**Files:**
- Create: `src/lib/voice/app-events.ts`
- Modify: `src/lib/voice/contracts.ts` (controls: `sendContext?(text)` silent and optional; `say?(text)` optional), `src/components/chat/voice/deepgram-adapter.tsx` (omit `sendContext`; expose `say` = `injectAgentMessage`), `src/components/chat/voice/elevenlabs-adapter.tsx` (`sendContext` = `sendContextualUpdate`), `src/lib/voice/tools.ts` (one prompt line explaining `app_events`)
- Test: `scripts/smoke-orbit-voice.ts`

**Interfaces:**
- Produces: `withAppEvents(result: string, events: readonly string[]): string`. Empty `events` returns `result` unchanged. A JSON object result gets an `app_events` array; anything else becomes `{"result": <original string>, "app_events": [...]}`.

- [ ] Step 1: Add smoke checks: object result gains `app_events`; empty events returns the same string; `"not json"` becomes `{result:"not json", app_events:[...]}`; a JSON array result is wrapped, not mutated; the voice prompt mentions `app_events`.
- [ ] Step 2: Run `npx tsx scripts/smoke-orbit-voice.ts` — expect FAIL (module missing).
- [ ] Step 3: Implement `withAppEvents`; update contract and both adapters.
- [ ] Step 4: Run the smoke — expect PASS. Run `npm run typecheck`.

### Task 2: Engine and store split

**Files:**
- Create: `src/lib/voice/call-store.ts`, `src/components/chat/voice/voice-engine.tsx`
- Modify: `src/components/chat/voice-panel.tsx` (view only), `src/components/chat/voice/voice-dock.tsx` (renders `<VoiceEngine>` unportalled when a call exists; portals only the view)

**Interfaces:**
- Consumes: `withAppEvents` (Task 1), `VoiceDockState.call` from `dock-store.ts`.
- Produces (`call-store.ts`):
  - `type VoiceCallView = { provider: VoiceProvider; active: boolean; mode: VoiceMode; busy: boolean; muted: boolean; error: string; failed: boolean; lines: TranscriptTurn[]; cards: VoiceCard[]; saveError: boolean; closing: boolean }`
  - `useVoiceCall(): VoiceCallView`, `voiceControls: { current: VoiceAgentControls | null }` (the ref `VoiceOrbit` reads), and `voiceActions: { start(fallback?: boolean): void; close(): Promise<void>; toggleMute(): void; retrySaves(): Promise<void>; settleCard(next: StoredProposedAction): void }`.
  - Actions are installed by the mounted `VoiceEngine`; with no engine they are no-ops.
- `VoiceEngine({ state, threadId, onClose })`: moves the `voice-panel.tsx` engine code (state, refs, `persist`, `stop`, `close`, timers, `askChat`, `events`/`stableEvents`, `start`, auto-start, adapters) apart from writing to the store. `settleCard` sends the note via `sendContext` when present, else queues it for `onTool` to attach with `withAppEvents`.
- Escape-to-end stays in the view (it depends on focus inside the view).

- [ ] Step 1: Implement store and engine; reduce `VoicePanel` to the view reading `useVoiceCall()`.
- [ ] Step 2: `npm run typecheck` and `npm run lint` — expect clean (0 errors).
- [ ] Step 3: `npx playwright test e2e/08-orbit-voice.spec.ts` — expect PASS unchanged.

### Task 3: Prove the fix in e2e, full checks, commit

**Files:**
- Modify: `e2e/08-orbit-voice.spec.ts`

- [ ] Step 1: In the Deepgram branch, assert no `InjectAgentMessage` frame was sent during the call.
- [ ] Step 2: `npm run test:smoke` and `npx playwright test e2e/08-orbit-voice.spec.ts` — expect PASS.
- [ ] Step 3: Commit spec, plan, and code on `claude/orbit-voice-revamp-61be74`.
