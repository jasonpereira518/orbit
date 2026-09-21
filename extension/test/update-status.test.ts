import { describe, expect, it } from "vitest";
import { isOutdated, updateOutcomeCopy } from "@/panel/state/update-status";

describe("isOutdated", () => {
  it("is false when the server speaks the version this build was made for", () => {
    expect(isOutdated(1, 1)).toBe(false);
  });

  it("is true when the server has moved ahead", () => {
    expect(isOutdated(2, 1)).toBe(true);
  });

  it("is false when this build is AHEAD of the server", () => {
    // Happens during a deploy: the Web Store shipped the new panel before the
    // server rolled out. Nagging the user to "update" would be wrong — they
    // already have the newest thing there is.
    expect(isOutdated(1, 2)).toBe(false);
  });

  it("does not guess from a missing version", () => {
    expect(isOutdated(undefined, 1)).toBe(false);
    expect(isOutdated(null, 1)).toBe(false);
  });
});

describe("updateOutcomeCopy", () => {
  it("reloads only when Chrome has an update ready", () => {
    expect(updateOutcomeCopy("update_available").reload).toBe(true);
    for (const outcome of ["no_update", "throttled", "unsupported"] as const) {
      expect(updateOutcomeCopy(outcome).reload).toBe(false);
    }
  });
});
