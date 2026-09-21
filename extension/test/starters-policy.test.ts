import { describe, expect, it } from "vitest";
import type { MeResponse } from "@contract";
import { startersPolicy } from "@/panel/state/starters-policy";

const me = (hasAiKey: boolean, starters?: boolean) =>
  ({
    capabilities: { hasAiKey, hasApolloKey: false, aiProvider: "anthropic" },
    entitlements:
      starters === undefined
        ? undefined
        : {
            plan: starters ? "orbit" : "free",
            planLabel: "",
            contactLimit: null,
            contactsRemaining: null,
            features: { starters, workHistory: starters, company: starters, search: starters },
          },
  }) as Pick<MeResponse, "capabilities" | "entitlements">;

describe("startersPolicy", () => {
  it("asks for AI lines on Pro with a key", () => {
    expect(startersPolicy(me(true, true))).toEqual({ fetchAi: true, reason: null });
  });

  it("does not spend an AI call on a plan that doesn't include it", () => {
    expect(startersPolicy(me(true, false))).toEqual({ fetchAi: false, reason: "plan" });
  });

  it("names the plan, not the key, when both are missing", () => {
    // Adding a key wouldn't unlock it; upgrading is the real next step.
    expect(startersPolicy(me(false, false)).reason).toBe("plan");
  });

  it("names the key on Pro without one", () => {
    expect(startersPolicy(me(false, true))).toEqual({ fetchAi: false, reason: "no_api_key" });
  });

  it("treats a v1 server's silence as unknown, not locked", () => {
    expect(startersPolicy(me(true))).toEqual({ fetchAi: true, reason: null });
    expect(startersPolicy(me(false)).reason).toBe("no_api_key");
  });
});
