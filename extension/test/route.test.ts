/**
 * The panel's view decision. Each case is a rung of the old if-ladder whose
 * position mattered — now written down.
 */
import { describe, expect, it } from "vitest";
import { deriveRoute, type RouteInput } from "@/panel/state/route";

const ready: RouteInput = {
  phase: "ready",
  pageError: null,
  pageErrorReason: null,
  resolving: false,
  hasPage: true,
  pageIsPerson: true,
  status: "none",
  hasContact: false,
  candidateCount: 0,
  forceCreate: false,
  staleOffline: false,
};
const route = (over: Partial<RouteInput>) => deriveRoute({ ...ready, ...over });

describe("deriveRoute", () => {
  it("a stranger's profile is a capture", () => {
    expect(route({}).name).toBe("new");
  });

  it("someone you know is the known view", () => {
    expect(route({ status: "confident", hasContact: true }).name).toBe("known");
  });

  it('"add as new" outranks a known match', () => {
    expect(route({ status: "confident", hasContact: true, forceCreate: true }).name).toBe("new");
  });

  it("an ambiguous match asks, unless the user already chose 'add as new'", () => {
    expect(route({ status: "ambiguous", candidateCount: 2 }).name).toBe("ambiguous");
    expect(route({ status: "ambiguous", candidateCount: 2, forceCreate: true }).name).toBe("new");
  });

  it("an ambiguous status with no candidates falls back to capture", () => {
    expect(route({ status: "ambiguous", candidateCount: 0 }).name).toBe("new");
  });

  describe("the three old dead ends are all Home", () => {
    it("an unclicked tab", () => {
      expect(route({ phase: "needs-permission", hasPage: false, status: null })).toEqual({
        name: "home",
        reason: "no-grant",
        detail: null,
        lostAccess: false,
      });
    });

    it("an unreadable page, carrying why", () => {
      const r = route({
        phase: "unsupported",
        pageError: "Orbit can't read browser pages.",
        pageErrorReason: "restricted",
        hasPage: false,
        status: null,
      });
      expect(r).toEqual({
        name: "home",
        reason: "unreadable",
        detail: "Orbit can't read browser pages.",
        lostAccess: false,
      });
    });

    it("a page that reloaded under the extension says so", () => {
      const r = route({ phase: "unsupported", pageErrorReason: "injection-failed", hasPage: false });
      expect(r.name === "home" && r.lostAccess).toBe(true);
    });

    it("a page about nobody", () => {
      expect(route({ pageIsPerson: false, status: "none" }).name).toBe("home");
    });
  });

  it("a non-person page that DOES match someone is still that person", () => {
    // A company page can resolve (e.g. via a link); only a miss becomes Home.
    expect(route({ pageIsPerson: false, status: "confident", hasContact: true }).name).toBe("known");
  });

  it("signed-out outranks everything", () => {
    expect(route({ phase: "signed-out", hasContact: true, status: "confident" }).name).toBe("signed-out");
  });

  it("a real failure with no data is the error view…", () => {
    expect(route({ phase: "error", status: null }).name).toBe("error");
  });

  it("…but offline with this page's last record shows that record", () => {
    expect(
      route({ phase: "error", staleOffline: true, status: "confident", hasContact: true }).name
    ).toBe("known");
  });

  it("is loading until there is both a page and an answer", () => {
    expect(route({ resolving: true }).name).toBe("loading");
    expect(route({ status: null }).name).toBe("loading");
    expect(route({ hasPage: false }).name).toBe("loading");
  });
});
