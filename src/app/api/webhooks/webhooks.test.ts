import "../../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { NextRequest } from "next/server";

function lineStarting(spy: ReturnType<typeof mock.method>, prefix: string) {
  return spy.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith(prefix));
}

describe("webhook routes report caught failures", () => {
  afterEach(() => mock.restoreAll());

  it("stripe: missing secret reports and still answers 500", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { POST } = await import("./stripe/route");
    const errorMock = mock.method(console, "error", () => {});
    const res = await POST(new Request("http://localhost/api/webhooks/stripe", { method: "POST", body: "{}" }) as NextRequest);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "Stripe webhook is not configured");
    assert.equal(lineStarting(errorMock, "[orbit:webhook.stripe.no-secret] ref=").length, 1);
  });

  it("stripe: bad signature reports (as a warning) and still answers 400", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit_test_secret";
    process.env.STRIPE_SECRET_KEY = "sk_test_unit_dummy";
    const { POST } = await import("./stripe/route");
    const warnMock = mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
    const res = await POST(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=bad" },
        body: "{}",
      }) as NextRequest
    );
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "Verification failed");
    assert.equal(lineStarting(warnMock, "[orbit:webhook.stripe.verify] ref=").length, 1);
  });

  it("clerk: failed verification reports (as a warning) and still answers 400", async () => {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${Buffer.from("unit-clerk-secret").toString("base64")}`;
    const { POST } = await import("./clerk/route");
    const warnMock = mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
    const res = await POST(
      new Request("http://localhost/api/webhooks/clerk", {
        method: "POST",
        headers: { "svix-id": "msg_unit", "svix-timestamp": "1", "svix-signature": "v1,bad" },
        body: "{}",
      }) as NextRequest
    );
    assert.equal(res.status, 400);
    assert.equal(lineStarting(warnMock, "[orbit:webhook.clerk.verify] ref=").length, 1);
  });
});
