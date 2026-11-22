import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type Stripe from "stripe";
import { periodEndOf } from "./billing-stripe";

describe("periodEndOf", () => {
  it("reports a subscription with no period end, and still returns null", () => {
    const errorMock = mock.method(console, "error", () => {});
    const result = periodEndOf({ id: "sub_none", items: { data: [{}] } } as unknown as Stripe.Subscription);
    assert.equal(result, null);
    const first = String(errorMock.mock.calls[0]?.arguments[0]);
    assert.ok(first.startsWith("[orbit:lib.billing-stripe.period-end] ref="), first);
    errorMock.mock.restore();
  });

  it("stays quiet when the item carries it", () => {
    const errorMock = mock.method(console, "error", () => {});
    assert.equal(periodEndOf({ id: "s", items: { data: [{ current_period_end: 5 }] } } as unknown as Stripe.Subscription), 5);
    assert.equal(errorMock.mock.callCount(), 0);
    errorMock.mock.restore();
  });
});
