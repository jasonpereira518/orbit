# Cosmo PR 2: the Cosmo shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Behind `feature.cosmo`, every signed-in page gets an idle Cosmo orb at the bottom of the corner column; clicking it starts a call in a per-day Cosmo thread, and off Chat the live call shows as Cosmo's docked view (orb, status, mute, open chat, end, cards, errors) instead of the middle-right pill.

**Spec:** `docs/superpowers/specs/2026-11-12-cosmo-design.md` (PR 2). Builds on PR 1 (`VoiceEngine`, `call-store`).

## Global Constraints
- Flag off (users): nothing changes. Localhost always previews unreleased surfaces, so dev and e2e see Cosmo on.
- No new routes, no schema change, no CSP change.
- One live call at a time; the engine must never remount mid-call (key on a call id, not the thread id).
- Deviation from spec, my call: the orb fetches `GET /api/voice` on mount and when the tab becomes visible instead of adding voice state to the app pulse.

## Review Focus
1. Stored day thread deleted since: the call still starts (fresh thread), no "conversation unavailable".
2. Toasts and the job stack sit above the orb, never on it (`--orbit-cosmo-height`).
3. Voice disabled by admin or `page.chat` hidden: no orb at all.
4. A Base UI modal open: the orb stays clickable and is not `aria-hidden` (`aria-live="off"` root).
5. Going from a Cosmo call into Chat: the inline stage shows (PR 3 matches threads), one socket.

### Task 1: Server
- `src/lib/surfaces.ts`: `COSMO_SURFACE_KEY = "feature.cosmo"`, `comingSoon: true`.
- `startVoiceSession(..., opts?: { freshIfMissing?: boolean })`: a missing `threadId` with `freshIfMissing` creates a new thread. Persona = `isSurfaceReleased(userId, COSMO_SURFACE_KEY)`.
- `voiceInstructions(userId, timeZone, name = "Orbit Voice")`; `voiceCredentials`/`deepgramCredentials` take a `greeting`. Cosmo greeting: "Hi, I’m Cosmo. What can I help with?". ElevenLabs keeps its agent's fixed first message (override lands in PR 11).
- Route: `freshIfMissing: z.boolean().default(false)` on `start`.
- Smoke: missing thread + `freshIfMissing` starts a new thread; without it, still refused.

### Task 2: Client
- `dock-store.ts`: `call: { id: string; threadId: string | null; state; origin: "chat" | "cosmo" }`; `openVoice(threadId | null, state, origin)`; `setCallThread(id)`.
- `VoiceEngine`: thread in a ref, adopted from the start response (`setCallThread`); sends `freshIfMissing` for Cosmo calls.
- `VoiceDock({ cosmo })`: keys engine and panel on `call.id`; with `cosmo`, the panel is portalled only into Chat's slot and `CosmoRoot` renders the corner.
- New `src/components/cosmo/cosmo-root.tsx` (+ `cosmo.css`): idle CSS orb button "Talk to Cosmo"; live docked view; day thread in `localStorage["orbit:cosmo-thread"]`; publishes `--orbit-cosmo-height`; hidden on `/onboarding`.
- `theme.css`: `--orbit-cosmo-height`, `--orbit-stack-bottom`; job stack and toasts stack above Cosmo.
- Layout passes `cosmo={!visibility.hidden.has(COSMO_SURFACE_KEY)}`.

### Task 3: Tests
- `e2e/08-orbit-voice.spec.ts`: docked assertions follow Cosmo's view (bottom-right).
- New `e2e/10-cosmo.spec.ts` (Deepgram mock): orb on dashboard → call → navigate → one socket, docked bottom-right, `--orbit-cosmo-height` set → end → idle orb back.
- typecheck, lint, voice smoke, both e2e specs.
