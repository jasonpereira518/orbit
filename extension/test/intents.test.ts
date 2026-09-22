import { describe, expect, it } from "vitest";
import { INTENT_TTL_MS, SELECTION_MAX_CHARS, shouldAccept, targetKey, type Intent } from "@/lib/intents";

const NOW = 1_800_000_000_000;
const click = (over: Record<string, unknown> = {}): Intent =>
  ({
    id: "click-1",
    at: NOW - 200,
    kind: "action",
    tabId: 7,
    windowId: 1,
    ...over,
  }) as Intent;
const ctx = (over: Partial<Parameters<typeof shouldAccept>[1]> = {}) => ({
  now: NOW,
  windowId: 1,
  lastAcceptedId: null,
  ...over,
});

describe("shouldAccept", () => {
  it("acts on a fresh click in its own window", () => {
    expect(shouldAccept(click(), ctx())).toBe(true);
  });

  it("never acts on the same click twice", () => {
    // The panel reads the intent on mount AND hears it as a change event.
    expect(shouldAccept(click(), ctx({ lastAcceptedId: "click-1" }))).toBe(false);
  });

  it("ignores a stale click", () => {
    expect(shouldAccept(click({ at: NOW - INTENT_TTL_MS - 1 }), ctx())).toBe(false);
  });

  it("ignores a click in another window", () => {
    expect(shouldAccept(click({ windowId: 2 }), ctx())).toBe(false);
  });

  it("accepts before the panel knows its own window", () => {
    // Right at mount, before windows.getCurrent resolves.
    expect(shouldAccept(click({ windowId: 2 }), ctx({ windowId: null }))).toBe(true);
  });

  it("a right-clicked link carries its URL", () => {
    const link = { ...click(), kind: "link", linkUrl: "https://www.linkedin.com/in/amara-osei" } as Intent;
    expect(shouldAccept(link, ctx())).toBe(true);
    expect(shouldAccept({ ...link, linkUrl: "" }, ctx())).toBe(false);
  });

  it("a right-clicked selection carries its text, within the cap", () => {
    const sel = { ...click(), kind: "selection", text: "She's hiring for infra." } as Intent;
    expect(shouldAccept(sel, ctx())).toBe(true);
    expect(shouldAccept({ ...sel, text: "   " }, ctx())).toBe(false);
    // The worker truncates; anything over the cap didn't come from it.
    expect(shouldAccept({ ...sel, text: "x".repeat(SELECTION_MAX_CHARS + 1) }, ctx())).toBe(false);
  });

  it("rejects anything that isn't an intent", () => {
    for (const junk of [null, undefined, "click", { id: "x" }, { ...click(), kind: "other" }]) {
      expect(shouldAccept(junk, ctx())).toBe(false);
    }
  });
});

describe("targetKey", () => {
  it("changes when the tab changes, even if neither URL is visible", () => {
    // The bug: both unreadable tabs had url "", the old follow logic saw no
    // change, and the previous person stayed on screen.
    expect(targetKey({ id: 1 })).not.toBe(targetKey({ id: 2 }));
  });

  it("changes when a visible URL changes within one tab", () => {
    expect(targetKey({ id: 1, url: "https://a" })).not.toBe(
      targetKey({ id: 1, url: "https://b" })
    );
  });

  it("is stable for the same tab at the same URL", () => {
    expect(targetKey({ id: 1, url: "https://a" })).toBe(targetKey({ id: 1, url: "https://a" }));
  });

  it("is null without a tab", () => {
    expect(targetKey(undefined)).toBeNull();
  });
});
