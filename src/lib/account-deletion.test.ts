import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";

const USER = "unit-acctdel-user";

describe("deleteOwnAccount reports caught failures", () => {
  after(() => mock.restoreAll());

  async function seed() {
    const { getDb } = await import("@/db");
    const { userSettings } = await import("@/db/schema");
    const { ensureUserSettings } = await import("@/lib/user-settings");
    await ensureUserSettings(USER);
    const db = await getDb();
    await db.update(userSettings).set({ stripeCustomerId: "cus_unit_del" }).where(eq(userSettings.userId, USER));
  }

  it("subscription cancel failure still refuses with the same message", async () => {
    await seed();
    const { deleteOwnAccount } = await import("./account-deletion");
    const errorMock = mock.method(console, "error", () => {});
    await assert.rejects(
      deleteOwnAccount(USER, { cancelSubscriptions: async () => { throw new Error("stripe"); }, deleteLogin: async () => {} }),
      /Couldn’t cancel your Orbit subscription, so nothing was deleted/
    );
    const lines = errorMock.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.filter((l) => l.startsWith("[orbit:account.delete.cancel-subscription] ref=")).length, 1);
    errorMock.mock.restore();
  });

  it("sign-in removal failure still throws the same message", async () => {
    await seed();
    const { deleteOwnAccount } = await import("./account-deletion");
    const errorMock = mock.method(console, "error", () => {});
    await assert.rejects(
      deleteOwnAccount(USER, { cancelSubscriptions: async () => {}, deleteLogin: async () => { throw new Error("clerk"); } }),
      /Your data is deleted, but your sign-in couldn’t be removed/
    );
    const lines = errorMock.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.filter((l) => l.startsWith("[orbit:account.delete.remove-login] ref=")).length, 1);
    errorMock.mock.restore();
  });
});
