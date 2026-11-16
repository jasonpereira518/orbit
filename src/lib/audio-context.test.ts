import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getAudioContextCtor } from "@/lib/audio-context";

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.window;
});

describe("getAudioContextCtor", () => {
  it("is null on the server (no window)", () => {
    assert.equal(getAudioContextCtor(), null);
  });
  it("prefers the standard constructor, falls back to webkit, else null", () => {
    class Std {}
    class Webkit {}
    g.window = { AudioContext: Std, webkitAudioContext: Webkit };
    assert.equal(getAudioContextCtor(), Std);
    g.window = { webkitAudioContext: Webkit };
    assert.equal(getAudioContextCtor(), Webkit);
    g.window = {};
    assert.equal(getAudioContextCtor(), null);
  });
});
