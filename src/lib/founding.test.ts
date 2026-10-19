import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type Stripe from "stripe";
import { reconcileFoundingDiscount } from "@/lib/founding";

describe("reconcileFoundingDiscount failure reporting", () => {
  it("reports through reportError and still resolves to the error result", async () => {
    const errors = mock.method(console, "error", () => {});
    try {
      // A subscription whose fields throw when read, so planning fails: the catch path.
      const sub = {
        id: "sub_test",
        get items(): never {
          throw new Error("boom");
        },
        get metadata(): never {
          throw new Error("boom");
        },
        get status(): never {
          throw new Error("boom");
        },
      } as unknown as Stripe.Subscription;
      const result = await reconcileFoundingDiscount(sub, async () => {});
      assert.deepEqual(result, { action: "none", reason: "error" });
      const line = String(errors.mock.calls[0]?.arguments[0]);
      assert.match(line, /^\[orbit:founding\.reconcile\] ref=/);
    } finally {
      errors.mock.restore();
    }
  });
});
