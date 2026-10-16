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
 * It does the least possible: copy each render quantum (or a batch of them) and post it. All resampling,
 * framing and metering happens on the main thread in `src/lib/voice-recording.ts`, where
 * it is testable under node.
 */
class OrbitPcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.recording = true;
    // `batchQuanta` render quanta go out as one message. 1 (voice notes, dictation) posts
    // every 128-sample quantum, about 375 messages a second; a long meeting asks for more so
    // the main thread, the resampler and the live socket each run ~30 times a second instead.
    var opts = (options && options.processorOptions) || {};
    this.batchQuanta = Math.max(1, Math.floor(opts.batchQuanta || 1));
    this.batch = null;
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.recording = false;
      // A pause: the part-filled batch is audio from before it, never to be sent after.
      if (event.data === "reset") this.batch = null;
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
    // transferring costs nothing and skips a structured clone of every frame.
    if (this.batchQuanta === 1) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
      return true;
    }
    // A quantum is 128 frames today, but the spec lets it vary, so fill by length.
    let i = 0;
    while (i < channel.length) {
      if (!this.batch) {
        this.batch = new Float32Array(128 * this.batchQuanta);
        this.filled = 0;
      }
      const take = Math.min(channel.length - i, this.batch.length - this.filled);
      this.batch.set(channel.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.batch.length) {
        const full = this.batch;
        this.batch = null;
        this.port.postMessage(full, [full.buffer]);
      }
    }

    return true;
  }
}

registerProcessor("orbit-pcm-recorder", OrbitPcmRecorder);
