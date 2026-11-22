import "../../scripts/smoke/_env";

import { after, before, describe, it } from "node:test";
import { mock } from "node:test";
import { getDashboardData } from "@/lib/reminders";
import { expectGolden, freezeClock } from "@/test-support/golden";
import { GOLDEN_USER, seedNetwork } from "@/test-support/fixtures";

describe("getDashboardData (golden)", () => {
  before(async () => {
    await seedNetwork();
    freezeClock();
  });
  after(() => mock.timers.reset());

  it("pins the dashboard payload over the seeded network", async () => {
    const data = await getDashboardData(GOLDEN_USER, { userName: "Golden" });
    expectGolden(import.meta.url, "dashboard-data", data);
  });
});
