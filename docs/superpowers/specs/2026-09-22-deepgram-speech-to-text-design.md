# Deepgram speech-to-text

**Date:** 2026-09-22
**Status:** approved design, not yet implemented
**Supersedes:** the Wispr Flow chain removed in #245

## Why

Speech-to-text is three pipelines today, and all of them need a key the user
pasted in Settings:

- **Meetings** upload ~60 s WAV chunks; the server transcribes each with Whisper
  or Gemini. The transcript lags about a minute and has no speaker labels.
- **Voice notes** upload one WAV and take the same path.
- **The chat mic** uses the browser's own speech recognition, which is poor in
  Safari and missing in some browsers, and never reaches our server.

Deepgram replaces all three as the first engine, on **Orbit's key**. That buys a
live meeting transcript with speaker labels, dictation that works in every
browser, and voice notes for accounts with no AI key at all. Whisper and Gemini
stay as fallbacks on the user's own key.

Because Orbit pays, every use is metered and meetings become a paid feature.

## Decisions

| Decision | Choice |
|---|---|
| Who gets Deepgram | Everyone, on Orbit's key, capped per plan |
| Meetings | **Pro and Lifetime only.** 5 h/month Pro, 10 h/month Lifetime |
| Voice notes + chat mic | Free 60 min/month, Pro and Lifetime 300 min/month |
| Live transport | Browser connects straight to Deepgram with a short-lived token |
| Speaker labels | Deepgram's own speaker detection on the mixed stream, one live pass |
| "You" | Derived locally from mic loudness, not from Deepgram |
| Whisper / Gemini | Fallbacks only, on the user's own key |
| Terms | Privacy page updated; `TERMS_VERSION` **not** bumped |

Rejected: relaying audio through our own server (Vercel functions cap at 5 min,
double bandwidth, compute cost); a second file-based pass after each meeting for
better labels (rejected as too costly for the gain); keeping chunked uploads as
the primary path (not live).

## Costs

Deepgram Nova-3, pay-as-you-go, billed per second:
streaming **$0.0077/min**, files **$0.0043/min** (2026-09 list price; a
promotion was running at $0.0048 and $0.0027).

Worst case per user per month, if every cap is used to the last second. The
short-form cap is priced at the streaming rate, because the chat mic streams and
a user could spend the whole cap there; voice notes within it cost the lower
file rate.

| Plan | Meetings | Short-form | Total |
|---|---|---|---|
| Free | — | $0.46 | **$0.46** |
| Pro | $2.31 | $2.31 | **$4.62** |
| Lifetime | $4.62 | $2.31 | **$6.93** |

Real usage will be far below this. Free users who never record cost nothing.

## Architecture

### `src/lib/deepgram.ts` (server only)

The only module that reads `DEEPGRAM_API_KEY`. Exports:

- `mintStreamToken(purpose)` — `POST https://api.deepgram.com/v1/auth/grant`,
  `ttl_seconds: 30`. Returns `{ accessToken, expiresIn }`.
- `transcribeFile(audio, opts)` — the pre-recorded API, for voice notes and
  recovered meeting chunks.
- `listenParams(opts)` — builds the query string for both, so live and file
  transcription share one definition of "how Orbit asks Deepgram to listen":
  `model=nova-3`, `smart_format=true`, `punctuate=true`, `encoding=linear16`,
  `sample_rate=16000`, `channels=1`, plus `keyterm` (contact names) and, for
  meetings, `diarize=true` and `tag=meeting:<sessionId>`.

It deliberately does **not** go through `ai-access.ts`. That gate is for LLM
provider keys and its managed path is Lifetime-only and switched off
(`MANAGED_AI_ENABLED = false`). Deepgram follows the hosted-Apollo shape
instead: Orbit's key, entitlement plus quota, usage recorded. The guard in
`scripts/smoke-ai-access.ts` is extended so no file outside `deepgram.ts` reads
the key or names a Deepgram host.

Keyterm prompting takes the existing contact vocabulary
(`transcription-vocabulary.ts`), which already ranks the most recently seen
contacts first. Deepgram caps keyterms at 500 tokens per request and recommends
20–50 terms, so a new shaper `vocabularyToKeyterms()` sits beside the Whisper
and Gemini ones.

### `src/lib/speech-quota.ts`

Two monthly meters, both in **audio seconds**:

- `meeting` — Pro 18,000 s (5 h), Lifetime 36,000 s (10 h), Free 0
- `shortform` — Free 3,600 s (60 min), Pro and Lifetime 18,000 s (300 min)

```
remainingSeconds(userId, kind) -> { limit, used, remaining, resetsAt }
```

The month is the calendar month in UTC, matching the managed-AI window helper.
Limits live beside the plan definitions in `plan-limits.ts` so pricing copy and
enforcement read the same numbers.

### New table: `speech_usage`

| column | notes |
|---|---|
| `id` | uuid pk |
| `user_id` | text, not null |
| `kind` | `'meeting' \| 'shortform'` |
| `seconds` | integer, audio seconds |
| `source` | `'stream' \| 'file'` |
| `session_id` | uuid, null for voice notes |
| `request_id` | Deepgram request id, null until known |
| `created_at` | timestamptz |

Indexed on `(user_id, created_at)`. One row per meeting session (updated as
segments land) or per voice note. Added to `purgeUserData`'s category registry
under the account's own data.

### Schema migration — version 87

1. create `speech_usage`
2. `meeting_transcript_segments.speaker text` (null for older rows)
3. `MeetingSegmentEngine` gains `deepgram`
4. `usage_events.provider` gains `deepgram`
5. `ALTER TABLE user_settings DROP COLUMN IF EXISTS wispr_api_key_encrypted`,
   and remove its three DDL sites in `src/db/index.ts`

Re-check the highest claimed version across all branches immediately before
implementing; 87 was free on 2026-09-22.

## Meetings

### Starting

1. `createMeetingSession` checks `canUseMeetings` (new entitlement) and
   `remainingSeconds(user, 'meeting') > 0`. Refusal copy names the reset date.
2. The browser calls `POST /api/capture/meetings/[id]/stream-token`, which
   re-checks the plan, the quota, session ownership and the recorder id, then
   returns `{ accessToken, keyterms, remainingSeconds }`.
3. The browser opens **one** connection to `wss://api.deepgram.com/v1/listen`
   with those params, and streams the existing 16 kHz mono PCM in ~100 ms frames.

One connection per meeting. No scheduled reconnects — they would reset
Deepgram's speaker numbering, and consistent labels were chosen over
finer-grained server enforcement.

### Transcript

Partial results render live in the panel. Finished utterances are batched and
posted about every 10 s to `POST /api/capture/meetings/[id]/segments`:

```
{ segments: [{ seq, startMs, endMs, speaker, text }] }
```

The browser keeps owning `seq`, as it does today, so resume and the unique
`(session_id, seq)` key work unchanged. The server writes `engine = 'deepgram'`,
updates `lastSeq` and `durationMs`, and updates the session's `speech_usage` row
from the highest `endMs` seen — so a browser that crashes mid-meeting still
counts the audio it used.

The local outbox keeps cutting ~60 s chunks but **no longer uploads them**. It
tracks a "covered to" watermark (the end of the last finished result) and drops
chunks behind it. It is now only a recovery buffer.

### "You"

The audio worklet gains a second output: per-100 ms loudness for the mic and for
the captured tab audio **separately, before mixing**. For each speaker Deepgram
reports, the client measures the share of that speaker's words falling in
mic-dominant frames. At ≥70% across at least 20 words, that speaker is labelled
`you`; the rest become `speaker-1`, `speaker-2`… in order of appearance. With no
mic, or in mic-only mode (one mic in a room), no `you` label is assigned.

This is pure and testable: frames plus word timings in, a label map out.

### Dropped connection

Reconnect with backoff, a new token each time. If the quota is gone, no token is
issued and the 100% stop runs. Audio recorded while disconnected is still in the
outbox: chunks from the watermark to the reconnect are uploaded through the
**existing chunk route**, transcribed with Deepgram's file API and then Whisper
or Gemini on the user's key, and land without a speaker label. The transcript
marks the break; Deepgram renumbers speakers after it, while `you` carries over
because it comes from the mic.

### Limits

- **90%**: one banner, "About 30 min of meeting time left this month".
- **100%**: the browser flushes the last utterance, closes the connection, ends
  the session and runs the digest as usual. Copy: "Recording stopped — you've
  used this month's 5 meeting hours. Resets Oct 1."
- New meetings are refused once the cap is reached.
- The 3 h per-meeting cap stays.
- **Nightly reconciliation**: a cron job compares Deepgram's usage per
  `meeting:<id>` tag against `speech_usage`. More than 10% over sends an ops
  alert. No automatic suspension. This is the backstop for a tampered client,
  which is the one hole the single-connection design leaves open.

### Digest

`meeting-digest.ts` stops saying "NO speaker labels" and instead reads
`You:` / `Speaker N:` turns, grouped by speaker rather than by chunk, and is told
labels may renumber at a marked reconnect.

### Plan gate

New `canUseMeetings` entitlement (Pro and Lifetime) with a `meetings`
`FeatureKey` and denial copy, enforced by a `requireMeetingsUser()` in
`plan-guards.ts` (modelled on `requireRecruitersUser`) at: `createMeetingSession`,
`resumeMeetingSession`, `analyzeMeetingSession`, the chunk route, the
stream-token route and the segments route. The capture page passes the flag down
so the Meeting tab shows an upgrade prompt instead of the recorder. Meetings are
added to the plan comparison table.

## Chat mic

`use-dictation.ts` keeps its exact public handle
(`{state, supported, listening, error, level, start, stop, cancel, toggle}`) and
both chat call sites are untouched. Behind it:

1. `POST /api/speech/token` (purpose `dictation`) → a 30 s token, keyterms, and
   the remaining short-form seconds.
2. A live Deepgram connection carrying mic audio from the existing PCM worklet.
3. Partial results update the composer span in place; finished ones seal it.
   The 1.5 s sentence pause and the 5-minute session cap are unchanged.

`dictation.ts`'s reducer is reused as-is: connection-open maps to `audiostart`,
results to `result`, socket errors to the existing error codes. Its tests must
keep passing untouched — that is the evidence dictation did not regress.

Falls back to the browser engine when the short-form quota is gone, Deepgram is
unreachable, or the token call fails. The handle exposes which engine is live so
the UI can say so quietly.

## Voice notes

The upload path is unchanged. Inside `transcribeAudioWithAI` the order becomes:

1. **Deepgram file API** on Orbit's key, with keyterms — when short-form quota
   remains
2. Whisper (`whisper-1`) on the user's own OpenAI key
3. Gemini on the user's own Gemini key

`canTranscribe` becomes "Deepgram quota remains, or an OpenAI or Gemini key
exists", so an account with no keys can record voice notes for the first time.
`TranscriptionEngine` gains `deepgram`, which already flows to the UI.

## Failure handling

| Failure | Behaviour |
|---|---|
| Deepgram unreachable at meeting start | Record on the existing chunked pipeline (file API, then Whisper/Gemini). One banner: live transcription unavailable. No speaker labels. |
| Live socket drops | Reconnect with backoff; outbox covers the gap. |
| Segment POST fails | Queued in the outbox and retried; the `(session, seq)` key makes repeats harmless. |
| Deepgram 401 | Ops alert; every use falls back to the existing chain. |
| Quota read fails | Fail **closed** for meetings, **open** for the chat mic. |
| Over quota, no personal key | Voice note refused with copy offering a key or an upgrade; the mic uses the browser engine. |

`ORBIT_DEEPGRAM=off` reverts all three uses to today's behaviour without a
deploy.

## Privacy and security

- Meeting and dictation audio goes **browser → Deepgram**; it never touches
  Orbit's servers or storage. Voice-note audio passes through the server in
  memory only, as today.
- Deepgram also receives a list of recent contact names as keyterms.
- The privacy page lists Deepgram as a processor and its "last updated" date
  moves. `TERMS_VERSION` is **not** bumped, so users are not re-prompted.
- Orbit's key never reaches the browser: only 30 s single-connection tokens do.
- CSP `connect-src` gains `wss://api.deepgram.com` (and the API host for the
  file path, which is server-side only). Microphone and display-capture
  permissions are already granted to self.
- New rate-limit bucket `speechToken`, about 30 per 5 min per user, so a stuck
  reconnect loop cannot mint tokens endlessly.
- Transcript text is already in `NEVER_REVEALABLE` for admins; `speech_usage`
  holds no content.

## Testing

**Pure** (`smoke-speech-quota`, `smoke-deepgram-params`, `smoke-speaker-map`):
quota arithmetic and the 90/100% thresholds; month boundaries; the request
builder including the keyterm token cap; the mic-loudness → `you` mapping,
including the ambiguous case where no speaker qualifies; fallback ordering.
`smoke-dictation` keeps passing unchanged.

**Database** (`smoke-speech-usage`, extends `smoke-meeting-*`, `smoke-schema-upgrade`):
usage accounting and idempotency; every meeting entry point returning 403 for a
Free account; segment writes with speakers; the migration including the dropped
Wispr column.

**Accuracy gate:** `scripts/eval-ai.ts --task transcribe` gains Deepgram and
scores it against Whisper and Gemini on the same spoken fixtures, with contact
names as the thing that must be right. Deepgram ships as first engine only if it
wins or ties on name accuracy.

**By hand, with a real key:** a two-voice meeting (labels, a forced reconnect,
the 90% and 100% paths), one dictation session in Safari, one voice note on an
account with no keys, and one over-quota run per meter.

## Phases

- **P0 — spike (throwaway).** Confirm a `/v1/auth/grant` token authenticates a
  browser WebSocket (subprotocol vs header), that it also works for the
  pre-recorded API, and what Deepgram retains by default. Everything below
  assumes P0's answers.
- **P1 — foundation.** `deepgram.ts`, `speech-quota.ts`, schema 87, voice notes
  on Deepgram with fallbacks, guard and smoke updates.
- **P2 — chat mic.** Token route, the new engine behind `use-dictation`,
  browser-engine fallback.
- **P3 — meetings.** Plan gate, stream-token and segments routes, live recorder,
  speaker labelling, outbox recovery, digest changes, quota banners and stop.
- **P4 — ops.** Nightly reconciliation cron, ops alerts, admin visibility of
  speech usage.
- **P5 — copy and docs.** Privacy page, pricing table, settings display of
  remaining minutes, `.env.example`, runbook.

## Open questions

- Exact Deepgram retention default, and whether an account-level
  zero-retention setting is needed (answered by P0).
- Whether the 20–50 keyterm slice should prefer recency (as today) or the
  people on the meeting's calendar invite. Recency ships first.
