import { describe, expect, it } from "vitest";
import { interactionLabel, shortAgo } from "@/lib/format";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe("shortAgo", () => {
  it.each([
    [0, "today"],
    [3, "3 d"],
    [21, "3 wk"],
    [150, "5 mo"],
    [800, "2 yr"],
  ])("%i days ago → %s", (days, want) => {
    expect(shortAgo(ago(days), NOW)).toBe(want);
  });

  it("never exceeds five characters, so the column never wraps", () => {
    for (const days of [0, 1, 13, 14, 59, 60, 364, 365, 5000]) {
      expect(shortAgo(ago(days), NOW)!.length).toBeLessThanOrEqual(5);
    }
  });

  it("is null without a date", () => {
    expect(shortAgo(null, NOW)).toBeNull();
    expect(shortAgo("not a date", NOW)).toBeNull();
  });
});

describe("interactionLabel", () => {
  it("prefers the server's label", () => {
    expect(interactionLabel("reach_out", "Reached out")).toBe("Reached out");
  });

  it("never shows a raw code when the server sent none", () => {
    expect(interactionLabel("reach_out")).toBe("Reach out");
    expect(interactionLabel("linkedin_message")).toBe("Linkedin message");
  });
});
