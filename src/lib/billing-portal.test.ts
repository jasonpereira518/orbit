import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";

const USER = "unit-portal-subscriber";

describe("createBillingPortalUrl", () => {
  it("reports a Stripe failure and still returns the same unavailable copy", async () => {
    const { getDb } = await import("@/db");
    const { userSettings } = await import("@/db/schema");
    const { ensureUserSettings } = await import("@/lib/user-settings");
    const { BILLING_PORTAL_COPY, createBillingPortalUrl } = await import("./billing-portal");
    await ensureUserSettings(USER);
    const db = await getDb();
    await db
      .update(userSettings)
      .set({ stripeCustomerId: "cus_unit_portal", subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: new Date(Date.now() + 20 * 86_400_000) })
      .where(eq(userSettings.userId, USER));

    const errorMock = mock.method(console, "error", () => {});
    const res = await createBillingPortalUrl(USER, {
      createSession: async () => {
        throw new Error("stripe down");
      },
    });
    assert.deepEqual(res, { error: BILLING_PORTAL_COPY.unavailable });
    const lines = errorMock.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.filter((l) => l.startsWith("[orbit:lib.billing-portal.session] ref=")).length, 1);
    errorMock.mock.restore();
  });
});
