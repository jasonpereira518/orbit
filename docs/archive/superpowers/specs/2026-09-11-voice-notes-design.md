# Voice notes: speak a conversation into Orbit

**Date:** 2026-09-11
**Status:** Built — three commits on `claude/wispr-voice-notes-feature-rrtaff`

## Problem

Verified against `main` at `820b466` before any of it was written.

The moment this targets is walking out of a coffee chat with a phone in one hand and
thirty seconds of attention. Orbit's only capture path was typing into `/capture`, and
typing is the one thing you cannot do while walking.

Three things were already true, and none of them pointed at that moment:

- **Capture already ingested audio *files*.** `normalizeCaptureInput`
  (`src/lib/capture-ingest.ts`) routes `audio/*` through `transcribeAudioWithAI`
  (`src/lib/ai.ts`), and `audio/webm` was already in both `isAudio` and the client's
  `CAPTURE_FILE_ACCEPT`. There was simply no way to *record* one — no `getUserMedia` or
  `MediaRecorder` anywhere in `src/`.
- **Dictation existed but was the wrong tool.** `src/lib/dictation.ts` +
  `use-dictation.ts` drive the Web Speech API in `/chat`. Effectively Chrome-only, and it
  cannot spell your contacts' names.
- **The extraction pipeline was done.** `parseBulkCaptureNotes` → review →
  `confirmBulkCapture` → `saveNoteBatch` already produced people, duplicate detection,
  mention links, dated-commitment reminders, action items and contact briefs.

So the feature is a *transcription source*, not a new pipeline.

## The thing that actually matters

A general speech model has never heard of the people you know. "Coffee with Priya Raman"
comes back as "Prea Ramen". In a networking CRM that is not a typo: the capture parser
reads the misspelling as someone it has never seen and creates a **second contact**. Voice
capture that forks your contacts on every note is worse than no voice capture.

Wispr Flow's transcribe endpoint takes a `dictionary_context` term list, which is the
entire reason to prefer it over Whisper. That is the feature; everything else is plumbing.

## What changed against the plan

**Wispr's API is partner-gated.** Discovered during implementation: it is not open signup.
Building the vocabulary for Wispr alone would have left the feature's whole point
unreachable for nearly every user.

So the term list is built once and handed to **whichever engine runs** — Wispr's
`dictionary_context`, Whisper's `prompt`, Gemini's prompt text. The chain is
Wispr → Whisper → Gemini and the names arrive either way. This is a change in scope from
the approved plan, and an improvement: the plan's Phase 3 was Wispr-only.

**The ingest stayed a server action.** The plan said "batch REST via a server route". A new
route handler would have re-implemented `requireUserId`, the `capture` rate-limit bucket
and the 32 MB body plumbing that `capture-limits.ts` warns is easy to get wrong in two
places, for the same security property — the key never reaches the browser either way.

## Decisions worth keeping

**WAV in the browser, not `MediaRecorder`.** Three reasons: Wispr takes base64 16 kHz WAV
and nothing else; Vercel's runtime has no ffmpeg to transcode webm/opus with; and one
format then feeds all three engines with no re-encoding in the fallback chain. The cost is
size — 32 KB/s against opus's 8 — which at the six-minute cap is ~11 MB, inside
`CAPTURE_MAX_UPLOAD_BYTES` with room to spare. `scripts/smoke-voice-recording.ts` pins that
sum, so raising `MAX_RECORDING_MS` fails a test rather than production.

**The worklet is a static file in `/public`.** The tidy version builds it from a string
with `URL.createObjectURL`. Orbit's CSP forbids it: `script-src` is `'self' 'unsafe-inline'`
with no `blob:`, and worklet modules load under `script-src`. Verified in Chromium — no CSP
violation.

**Resample on arrival, not at stop.** Turns a 33 MB float buffer into an 11 MB int one at
the cap, and spreads the cost over the session instead of stalling the stop button.

**The cap stops and *keeps* the recording.** Losing six minutes of someone's speech to a
length limit would be the worst thing this feature could do.

**Whole names for everyone before any name fragment.** Every engine truncates, so a
truncated list should cover the whole network shallowly rather than one corner deeply.
Rows are ordered most-recently-seen first for the same reason.

**The engine that won is reported.** A user who configured Wispr and silently got Whisper
would otherwise see only worse-spelled names and no reason.

## Two bugs the tests caught

1. **`desc(sql\`… NULLS LAST\`)` is invalid SQL.** Drizzle appends its keyword *after* the
   fragment. `loadNetworkVocabulary` catches and returns `[]` by design, so the broken
   query read as "this user has no contacts" and the entire vocabulary feature was doing
   nothing, silently. Only a test against a real database could find it — hence
   `smoke-transcription-vocabulary.ts` existing alongside the pure `smoke-wispr.ts`.
2. **`der` was missing from the name-particle list**, so "van der Berg" contributed "der"
   as a term to bias the transcriber toward.

## Not done

- **The Wispr wire format is unverified.** `api-docs.wisprflow.ai` is unreachable from the
  environment this was built in. Endpoint, auth header and body shape are reconstructed
  from documentation excerpts and grouped at the top of `src/lib/wispr.ts` with that stated
  plainly. Check them there before debugging a failure.
- **The accuracy claim is untested.** Nobody has recorded a real sentence naming a real
  contact and compared engines. Until someone does, "Wispr spells your contacts right" is a
  reasoned expectation, not a measured result.
- WebSocket streaming; a PWA manifest or share target; persisting audio (recordings stay
  ephemeral, as `ingestCaptureMedia` already promises for all capture media); a mic on the
  ⌘K ask bar.

## Verification

`npx tsc --noEmit` clean, `npx next build` passes, eslint adds no errors, 126/128 smoke
tests pass — the two failures (`smoke-write-path`, `smoke-avatar-storage`) were verified
identical on a clean tree.

End to end in Chromium with `--use-fake-device-for-media-stream`: the worklet loads with no
CSP violation, `?mode=voice` opens on an 80 px record button, the clock advances, and
stopping posts **116,220 bytes for 2.6 s** — exactly 16 kHz mono int16 plus base64 overhead,
which is what confirms the resampler and WAV framing are correct on a real device rather
than only in the unit test.

What still needs a human: recording a real sentence with an AI key configured, and the
side-by-side accuracy comparison above.
