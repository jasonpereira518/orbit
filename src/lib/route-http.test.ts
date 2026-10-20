import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextResponse } from "next/server";
import { RateLimitedError } from "@/lib/rate-limit";

/** The literal block every migrated route used before the helper existed. */
function legacy(err: RateLimitedError) {
  return NextResponse.json(
    { error: err.message },
    { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
  );
}

describe("rateLimitedResponse", () => {
  for (const [scope, sec] of [["export", 30], ["chat", 1], ["meetingChunk", 3600]] as const) {
    it(`matches the hand-written 429 (${scope}, ${sec}s)`, async () => {
      const { rateLimitedResponse } = await import("./route-http");
      const err = new RateLimitedError(scope, sec);
      const a = rateLimitedResponse(err);
      const b = legacy(err);
      assert.equal(a.status, 429);
      assert.equal(a.headers.get("Retry-After"), String(sec));
      assert.equal(a.headers.get("content-type"), b.headers.get("content-type"));
      assert.deepEqual(await a.json(), { error: err.message });
      assert.deepEqual([...a.headers.entries()].sort(), [...b.headers.entries()].sort());
    });
  }
});
