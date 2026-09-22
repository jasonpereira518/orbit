import { describe, expect, it } from "vitest";
import type { PageContext, ProfileCaptureResponse } from "@contract";
import { canReadWorkHistory, captureOutcome, detailsUrl, profileListsOnlySome } from "@/lib/work-history";

const page = (over: Partial<PageContext> = {}): PageContext =>
  ({
    schemaVersion: 1,
    site: "linkedin",
    kind: "person",
    identity: { handle: { value: "amara-osei", source: "url", confidence: "high" } },
    text: { blob: "x", truncated: false, charCount: 1, fromSelection: false },
    warnings: [],
    ...over,
  }) as PageContext;

const history = { roles: [], roleCount: 3, schools: [], schoolCount: 1, source: "extension" as const, capturedAt: "" };

describe("captureOutcome", () => {
  it("says what it saved", () => {
    const res: ProfileCaptureResponse = { status: "saved", dropped: 0, workHistory: history };
    expect(captureOutcome(res)).toEqual({ tone: "ok", text: "Saved 3 roles and 1 school." });
  });

  it("a shortened list saved says the full list has more, and offers it", () => {
    const res: ProfileCaptureResponse = { status: "saved", dropped: 0, shortened: ["experience"], workHistory: history };
    const out = captureOutcome(res);
    expect(out.tone).toBe("warn");
    expect(out.openSection).toBe("experience");
  });

  it("partial says nothing changed and points at the full list", () => {
    const out = captureOutcome({ status: "partial", dropped: 0, openSection: "education" });
    expect(out.text).toMatch(/nothing changed/);
    expect(out.openSection).toBe("education");
  });

  it("no key offers the settings, and never reads as the page's fault", () => {
    const out = captureOutcome({ status: "degraded", degradedReason: "no_api_key", dropped: 0 });
    expect(out.settings).toBe(true);
    expect(captureOutcome({ status: "degraded", degradedReason: "ai_error", dropped: 0 }).text).toMatch(/Try again/);
  });
});

describe("where it can read", () => {
  it("a LinkedIn profile, not a selection, not another site", () => {
    expect(canReadWorkHistory(page())).toBe(true);
    expect(canReadWorkHistory(page({ site: "x" }))).toBe(false);
    expect(canReadWorkHistory(page({ kind: "post" }))).toBe(false);
    expect(canReadWorkHistory(page({ text: { blob: "x", truncated: false, charCount: 1, fromSelection: true } }))).toBe(false);
  });

  it("the shortened hint is for the profile, never its details page", () => {
    expect(profileListsOnlySome(page({ warnings: ["experience-shortened"] }))).toBe(true);
    expect(profileListsOnlySome(page({ warnings: ["experience-shortened"], section: "experience" }))).toBe(false);
  });

  it("the details page is built from the slug", () => {
    expect(detailsUrl(page(), "experience")).toBe("https://www.linkedin.com/in/amara-osei/details/experience/");
  });
});
