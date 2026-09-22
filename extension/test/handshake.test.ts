import { describe, expect, it, vi } from "vitest";
import { followedSites, handleExternalMessage, HELLO, SESSION_CHANGED, type HandshakeDeps } from "@/lib/handshake";

const APP = "https://orbit.example";
const deps = (over: Partial<HandshakeDeps> = {}): HandshakeDeps => ({
  appOrigin: APP,
  version: () => "1.4.0",
  grantedOrigins: async () => ["https://*.linkedin.com/*", "https://github.com/*", "https://orbit.example/*"],
  poke: vi.fn(async () => {}),
  ...over,
});

describe("handleExternalMessage", () => {
  it("hello: the version and the sites it follows, by name", async () => {
    expect(await handleExternalMessage({ type: HELLO }, APP, deps())).toEqual({
      ok: true,
      version: "1.4.0",
      sites: ["LinkedIn", "GitHub"],
    });
  });

  it("answers nobody but the app's own origin", async () => {
    const d = deps();
    expect(await handleExternalMessage({ type: HELLO }, "https://evil.example", d)).toBeNull();
    expect(await handleExternalMessage({ type: SESSION_CHANGED }, "https://orbit.example.evil.com", d)).toBeNull();
    expect(await handleExternalMessage({ type: HELLO }, undefined, d)).toBeNull();
    expect(d.poke).not.toHaveBeenCalled();
  });

  it("session-changed pokes the panels, and carries nothing else", async () => {
    const d = deps();
    expect(await handleExternalMessage({ type: SESSION_CHANGED, url: "https://x" }, APP, d)).toEqual({ ok: true });
    expect(d.poke).toHaveBeenCalledTimes(1);
  });

  it("ignores anything else", async () => {
    for (const junk of [null, "hello", {}, { type: "orbit/open-panel" }, { type: HELLO.toUpperCase() }]) {
      expect(await handleExternalMessage(junk, APP, deps())).toBeNull();
    }
  });

  it("a failing permissions read still answers hello", async () => {
    const reply = await handleExternalMessage({ type: HELLO }, APP, deps({ grantedOrigins: async () => { throw new Error("x"); } }));
    expect(reply).toEqual({ ok: true, version: "1.4.0", sites: [] });
  });
});

describe("followedSites", () => {
  it("never leaks an origin it doesn't know", () => {
    expect(followedSites(["https://bank.example/*"])).toEqual([]);
  });
});
