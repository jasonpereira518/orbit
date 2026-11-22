import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, describe, it, mock } from "node:test";
import { installBrowser } from "@/lib/test-support/external-store-harness";
import * as gate from "@/lib/idle-gate";

const env = installBrowser();
after(() => env.restore());

describe("idle-gate", () => {
  it("goes idle after IDLE_AFTER_MS without input and resumes once on the next input", () => {
    mock.timers.enable({ apis: ["Date"] });
    let resumed = 0;
    const off = gate.onResume(() => resumed++);
    assert.equal(gate.isIdle(), false);
    mock.timers.tick(gate.IDLE_AFTER_MS + 1);
    assert.equal(gate.isIdle(), true);
    env.window.dispatch("pointermove");
    assert.equal(gate.isIdle(), false);
    assert.equal(resumed, 1);
    env.window.dispatch("pointermove");
    assert.equal(resumed, 1, "input while active does not resume again");
    // `touch` (the tab becoming visible) ends idleness without notifying.
    mock.timers.tick(gate.IDLE_AFTER_MS + 1);
    gate.touch();
    assert.equal(gate.isIdle(), false);
    assert.equal(resumed, 1);
    off();
    assert.equal(env.window.count("pointermove"), 0, "no listeners once nothing is subscribed");
    mock.timers.reset();
  });
});
