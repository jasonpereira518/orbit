/**
 * The microphone tap for voice capture. Loaded by `src/lib/use-voice-recorder.ts` via
 * `audioWorklet.addModule("/orbit-pcm-worklet.js")`.
 *
 * WHY THIS IS A STATIC FILE AND NOT A BLOB URL. The tidy way to ship a worklet is to build
 * it from a string with `URL.createObjectURL`, keeping it in the same module as its only
 * caller. Orbit's CSP (`src/lib/security-headers.ts`) forbids it: `script-src` is
 * `'self' 'unsafe-inline'` with no `blob:`, and worklet modules are fetched under
 * `script-src`. Served from /public it is same-origin, so `'self'` covers it and no CSP
 * change is needed. That is also why this file is plain ES5-ish JavaScript with no build
 * step — nothing in the Next pipeline touches /public.
 *
 * It does the least possible: copy each render quantum and post it. All resampling,
 * framing and metering happens on the main thread in `src/lib/voice-recording.ts`, where
 * it is testable under node.
 */
class OrbitPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.recording = false;
    };
  }

  process(inputs) {
    if (!this.recording) {
      // Returning false lets the engine collect this node. The main thread has already
      // stopped the tracks by the time this runs.
      return false;
    }

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    // A disconnected or not-yet-warm input gives a zero-length channel rather than null on
    // some builds; either way there is nothing to post and the node must stay alive.
    if (!channel || channel.length === 0) return true;

    // The engine reuses this buffer for the next quantum, so a reference would be
    // overwritten before the main thread ever reads it. Copy, then transfer the copy —
    // transferring costs nothing and skips a structured clone of every 128-sample frame.
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    this.port.postMessage(copy, [copy.buffer]);

    return true;
  }
}

registerProcessor("orbit-pcm-recorder", OrbitPcmRecorder);
