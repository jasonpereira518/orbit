import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDemoProspect } from "@/lib/outreach-channels";
import { isDemoProspect as viaQuality } from "@/lib/outreach-quality";

describe("isDemoProspect: one definition (prefix OR flag)", () => {
  it("quality re-exports the channels function", () => assert.equal(viaQuality, isDemoProspect));
  const rows: Array<[string, { externalId?: string | null; enrichment?: unknown }, boolean]> = [
    ["demo- externalId", { externalId: "demo-1" }, true],
    ["enrichment.demo true", { enrichment: { demo: true } }, true],
    ["demo- externalId even with demo:false", { externalId: "demo-1", enrichment: { demo: false } }, true],
    ["DEMO- is case-sensitive", { externalId: "DEMO-1" }, false],
    ["real id", { externalId: "real-1" }, false],
    ["demo:'true' string", { enrichment: { demo: "true" } }, false],
    ["null / empty", {}, false],
  ];
  for (const [label, p, want] of rows) it(label, () => assert.equal(isDemoProspect(p), want));
});
