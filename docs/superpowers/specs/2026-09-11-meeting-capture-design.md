# Meeting capture: listen along to a Zoom or Meet call

**Date:** 2026-09-11
**Status:** Built. Automated tests pass; not yet tried on a real call (see "What still needs a human").

## Problem

Capture had three ways in: voice notes (six minutes, mic only), messy notes and
structured logging. None of them fits the most information-dense conversation a person
has: a 30–60 minute video call. The goal was to keep `/capture` open during the call and,
when it ends, have the transcript, a summary, the people, reminders, action items,
blockers and open questions, landing in the existing review-and-save flow.

As with voice notes, this is a **new transcription source feeding the existing pipeline**,
not a second pipeline. Audio is never stored, only text.

## How it works

```
getDisplayMedia (tab / system audio) ─┐
getUserMedia (mic, AEC on) ───────────┴─► one mono worklet node ─► 16 kHz int16
  ─► MeetingChunker (~60 s, cut at a pause, 90 s hard cap)
  ─► IndexedDB outbox ─► POST /api/capture/meetings/[id]/chunks (raw WAV)
      ─► transcribeAudioWithAI (Wispr → Whisper → Gemini, contact vocabulary)
      ─► meeting_transcript_segments
Stop ─► endMeetingSession ─► drain ─► analyzeMeetingSession
  ─► digest (summary, decisions, action items, blockers, questions, participants)
  ─► compact first-person corpus ─► parseBulkCaptureNotes (people + dated reminders)
  ─► BulkNotesPanel review ─► confirmBulkCapture({ meeting }) ─► /capture/[batchId]
```

## Decisions worth keeping

**The call's audio comes from screen sharing.** A page cannot read the speakers. It can
ask to share a tab or screen *with audio*: a Meet tab with "Also share tab audio", or, for
the Zoom app, the entire screen with "Also share system audio". That second option exists
on Windows and ChromeOS, and on macOS from Chrome 141 with macOS 14.2+. This only works
in desktop Chromium; Safari and Firefox return video with no audio. The video track Chrome
insists on is kept but disabled, not stopped, because stopping it can end the capture on
some builds.

**The mic is mixed in.** The speakers carry everyone except the user, so without the mic
the user's own commitments would be missing. Both sources feed one worklet node with
`channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers"`. That
setting matters: the worklet reads channel 0 only, and shared tab audio is stereo. The
cost is no speaker labels, so action-item owners are attributed only when a name is
spoken. The setup copy recommends headphones, since Chrome's echo cancellation doesn't
remove the Zoom app's audio.

**Chunk boundaries run on the audio clock.** During the call the Orbit tab is in the
background, where Chrome throttles timers to about once a minute. The worklet is not
throttled, so the chunker cuts on sample counts.

**Cut at a pause.** Cutting mid-word loses the word from both chunks. After 60 s the
chunker waits for 400 ms of quiet and cuts there; 90 s is the hard cap (about 2.9 MB of
WAV, under Vercel's 4.5 MB body limit). Quiet means near the noise floor (the minimum over
the last 3 s) *and* well below the recent peak. The peak test was added when the smoke
test showed that a steady sound makes the floor equal the sound, so every frame read as a
pause. The previous chunk's transcript tail is also sent as Whisper/Gemini context, so a
hard cut usually heals.

**Silence is decided in absolute terms.** A chunk is skipped (sent as a marker, no audio)
only when almost nothing in it clears -50 dBFS. A false "silent" loses someone's words; a
false "sound" only costs one transcription call.

**Chunks go through a route handler, not a server action.** Next dispatches server actions
one at a time per client, so a ten-second transcription would block every other action on
the page. The route also takes raw bytes rather than base64.

**Exactly once, whatever the network does.** Each chunk is written to an IndexedDB outbox
before it is uploaded and removed only on acknowledgement. The server is idempotent on
`(session_id, seq)`. A crashed or closed tab therefore ends in a "Resume" banner, with the
outbox drained by whichever tab picks the meeting up. A recorder id per tab stops two tabs
interleaving audio into one meeting (409).

**The digest reads the transcript; the people parse reads the digest.** An hour is about
55k characters. The existing two-pass people parse would send all of it once per four
people, sequentially, each call under a 45 s deadline. Its prompts also assume a single
"I", and the dates pass truncates at 60k and swallows truncated JSON as "no dates". So
`meeting-digest.ts` reads the transcript once (map-reduce above 30k characters, at most
three calls in flight for free-tier BYO keys). It writes first-person notes plus the
verbatim lines that carry dates, and `parseBulkCaptureNotes` reads that corpus instead.

**Nothing the model says is trusted blind.** Any excerpt or due phrase not found in the
transcript is cleared, and any dated quote not found in it is dropped. In meeting mode,
dated commitments are validated against the **transcript**, not the corpus, so a date the
digest invented cannot become a reminder. The digest saved on the note batch is read from
the session on the server, never from the client.

## A bug the tests found in the existing code

Calling `downsampleTo16k` on each 128-sample worklet frame floors the fractional output:
128 samples at 48 kHz is 42.67 outputs, 42 are kept, and the last two inputs of every
frame are dropped. That loses 1.6% of the audio, puts a discontinuity every 2.7 ms, and
over an hour of meeting makes the timeline almost a minute short. `createDownsampler`
carries the tail and the fractional phase across frames. Meeting capture uses it.
**`use-voice-recorder.ts` still uses the per-frame call** and has the same loss; switching
it is a one-line change, left for a separate commit.

## Not done

- **Speaker labels.** Would need separate mic and call tracks transcribed separately, at
  twice the transcription cost. The cheaper next step is to tag each chunk as mostly-me or
  mostly-them from the two meters.
- **Anthropic-only accounts can't transcribe.** The tab explains this and links to Settings.
- **A meeting started from the Chrome extension** (`tabCapture`), which would not need the
  share picker.

## Verification

- `smoke-meeting-chunking` (pure): pause and hard cuts, café-noise pauses, silence, resume
  numbering, sample-exact 48k/44.1k end to end.
- `smoke-meeting-digest` (pure): schema tolerance, grounding, split/merge, corpus.
- `smoke-meeting-upload-queue` (pure): order, drain-after-Stop, retries, stop codes.
- `smoke-meeting-sessions` (pglite): idempotent seqs, out-of-order assembly, recorder lock,
  meeting-only save, reminders once, undo, discard.
- `smoke-purge`, `smoke-security-headers` and `smoke-schema-ddl` were updated.

## What still needs a human

A real call. Specifically:

- A Meet tab with tab audio, left in the background for more than 5 minutes.
- The Zoom app on Windows with system audio.
- Chrome's "Stop sharing" bar.
- Going offline mid-call.
- Killing the tab and resuming.
- Checking that stopping versus disabling the video track keeps audio flowing on current
  Chrome.
