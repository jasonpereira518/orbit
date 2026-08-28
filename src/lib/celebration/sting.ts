/**
 * The celebration's sound, synthesized — the repo ships no audio assets and
 * this keeps it that way. Six voices for the new arc: a rising sweep under
 * the accretion (scored to cut to silence at the collapse — the cut IS the
 * anticipation), a detonation-plus-shimmer at ignition, a pentatonic pluck
 * per perk card, a rising swell under the ring sweep, a two-note bell when
 * the ring completes, and a warm pad at rest.
 *
 * Sound here is strictly best-effort. The comped path arrives with no user
 * gesture, so the context may sit suspended until the viewer's first
 * click/keypress (`unlock()`); a browser that never allows it simply plays
 * nothing. Every method body is guarded — audio failure must never take the
 * visuals down with it.
 */

export type Sting = {
  /** Retry `resume()` — wired to the stage's first pointer/key event. */
  unlock: () => void;
  /** Rising sweep across the accretion; ends in silence at `ms`. */
  sweep: (ms: number) => void;
  /** Noise crack + sub drop + harmonic bloom. */
  ignite: () => void;
  /** Card `i` plucks the next step of a pentatonic climb. */
  tick: (i: number) => void;
  /** Rising filtered-noise swell whose crest meets the ring completing. */
  finaleSwell: () => void;
  /** Two-note bell — bright, conclusive, brief. */
  chime: () => void;
  /** Warm low pad; also what a skip lands on. */
  restPad: () => void;
  /** Fast-release everything sustained (skip jumps to rest). */
  stopAll: () => void;
  /** Close the context on stage unmount. */
  dispose: () => void;
};

const NOOP: Sting = {
  unlock() {},
  sweep() {},
  ignite() {},
  tick() {},
  finaleSwell() {},
  chime() {},
  restPad() {},
  stopAll() {},
  dispose() {},
};

/** Just pentatonic ratios; the climb resolving on the octave is the
 * cascade's completion cue. */
const PENTATONIC = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2] as const;

type Sustained = { gain: GainNode; sources: AudioScheduledSourceNode[] };

export function createSting(): Sting {
  let ctx: AudioContext;
  let master: GainNode;
  try {
    if (typeof AudioContext === "undefined") return NOOP;
    ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  } catch {
    return NOOP;
  }

  // Anything long enough for a skip to interrupt registers here so `stopAll`
  // can release it instead of letting scheduled ramps play into the rest.
  let sustained: Sustained[] = [];

  const guarded =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch {
        // Silence is the failure mode, by design.
      }
    };

  function noiseBuffer(seconds: number) {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function sustain(gain: GainNode, sources: AudioScheduledSourceNode[]) {
    const entry: Sustained = { gain, sources };
    sustained.push(entry);
    // Self-prune when the longest voice finishes naturally, so a later
    // `stopAll` never touches already-stopped nodes.
    const last = sources[sources.length - 1];
    last.addEventListener("ended", () => {
      sustained = sustained.filter((s) => s !== entry);
    });
  }

  return {
    unlock: guarded(() => {
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    }),

    sweep: guarded((ms: number) => {
      const t = ctx.currentTime;
      const end = t + ms / 1000;
      const rise = ctx.createGain();
      rise.gain.setValueAtTime(0.0001, t);
      rise.gain.exponentialRampToValueAtTime(0.28, end - 0.45);
      // The last 450ms ramp all the way down: COLLAPSE is scored as silence.
      rise.gain.exponentialRampToValueAtTime(0.0001, end);
      rise.connect(master);

      // Wind: looping noise through a slowly opening lowpass.
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer(1);
      noise.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(120, t);
      lp.frequency.exponentialRampToValueAtTime(1800, end - 0.3);
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.5;
      noise.connect(lp).connect(noiseGain).connect(rise);
      noise.start(t);
      noise.stop(end + 0.05);

      // Gravity: two detuned sawtooth risers climbing an octave underneath.
      const sources: AudioScheduledSourceNode[] = [noise];
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.detune.value = detune;
        osc.frequency.setValueAtTime(110, t);
        osc.frequency.exponentialRampToValueAtTime(220, end);
        const oscGain = ctx.createGain();
        oscGain.gain.value = 0.22;
        osc.connect(oscGain).connect(rise);
        osc.start(t);
        osc.stop(end + 0.05);
        sources.push(osc);
      }
      sustain(rise, sources);
    }),

    ignite: guarded(() => {
      const t = ctx.currentTime;
      // The crack: a bandpassed noise burst.
      const crack = ctx.createBufferSource();
      crack.buffer = noiseBuffer(0.35);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 2000;
      band.Q.value = 1;
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.5, t);
      crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      crack.connect(band).connect(crackGain).connect(master);
      crack.start(t);

      // The weight: a sub-bass drop under it.
      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(90, t);
      sub.frequency.exponentialRampToValueAtTime(34, t + 0.65);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.45, t);
      subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
      sub.connect(subGain).connect(master);
      sub.start(t);
      sub.stop(t + 0.7);

      // The shimmer: a late harmonic bloom — root-fifth-octave, plus a high
      // airy cluster for stardust. Long tails, so a skip must be able to cut
      // them.
      const bloom = ctx.createGain();
      bloom.gain.value = 1;
      bloom.connect(master);
      const bloomSources: AudioScheduledSourceNode[] = [];
      const b = t + 0.08;
      for (const [freq, gain, decay] of [
        [220, 0.1, 1.8],
        [330, 0.08, 1.8],
        [440, 0.07, 1.8],
        [2500, 0.02, 1.2],
        [3300, 0.016, 1.2],
        [4100, 0.012, 1.2],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(gain, b);
        g.gain.exponentialRampToValueAtTime(0.001, b + decay);
        osc.connect(g).connect(bloom);
        osc.start(b);
        osc.stop(b + decay + 0.05);
        bloomSources.push(osc);
      }
      sustain(bloom, bloomSources);
    }),

    tick: guarded((i: number) => {
      const t = ctx.currentTime;
      const step = PENTATONIC[Math.min(i, PENTATONIC.length - 1)];
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 440 * step;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.connect(gain).connect(master);
      osc.start(t);
      osc.stop(t + 0.2);
      // A breath of air on the attack.
      const air = ctx.createBufferSource();
      air.buffer = noiseBuffer(0.04);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 4000;
      const airGain = ctx.createGain();
      airGain.gain.setValueAtTime(0.06, t);
      airGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      air.connect(hp).connect(airGain).connect(master);
      air.start(t);
    }),

    finaleSwell: guarded(() => {
      const t = ctx.currentTime;
      const swell = ctx.createBufferSource();
      swell.buffer = noiseBuffer(0.6);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(600, t);
      band.frequency.exponentialRampToValueAtTime(2400, t + 0.4);
      band.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.4);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      swell.connect(band).connect(gain).connect(master);
      swell.start(t);
      sustain(gain, [swell]);
    }),

    chime: guarded(() => {
      const t = ctx.currentTime;
      for (const [freq, at] of [
        [659.25, 0], // E5
        [987.77, 0.12], // B5
      ] as const) {
        const start = t + at;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.12, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 1.6);
        osc.connect(gain).connect(master);
        osc.start(start);
        osc.stop(start + 1.65);
        // One inharmonic partial gives it bell instead of beep.
        const partial = ctx.createOscillator();
        partial.type = "sine";
        partial.frequency.value = freq * 2.76;
        const pGain = ctx.createGain();
        pGain.gain.setValueAtTime(0.03, start);
        pGain.gain.exponentialRampToValueAtTime(0.001, start + 0.8);
        partial.connect(pGain).connect(master);
        partial.start(start);
        partial.stop(start + 0.85);
      }
    }),

    restPad: guarded(() => {
      const t = ctx.currentTime;
      const pad = ctx.createGain();
      pad.gain.setValueAtTime(0.0001, t);
      pad.gain.exponentialRampToValueAtTime(0.14, t + 0.5);
      pad.gain.exponentialRampToValueAtTime(0.0001, t + 3.1);
      pad.connect(master);
      const sources: AudioScheduledSourceNode[] = [];
      for (const freq of [110, 165]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        osc.connect(g).connect(pad);
        osc.start(t);
        osc.stop(t + 3.2);
        sources.push(osc);
      }
      sustain(pad, sources);
    }),

    stopAll: guarded(() => {
      const t = ctx.currentTime;
      for (const { gain, sources } of sustained) {
        try {
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
          for (const src of sources) src.stop(t + 0.12);
        } catch {
          // A voice that already ended has nothing left to cut.
        }
      }
      sustained = [];
    }),

    dispose: guarded(() => {
      void ctx.close().catch(() => {});
    }),
  };
}
