import "../../scripts/smoke/_env";
/**
 * Characterization of the admin SQL-row coercers (plan P4.4): `num` and `toDate` from
 * `admin-metrics.ts`, which the other admin modules now import instead of redefining.
 * The table is what every former copy answered (all identical except admin-trends'
 * unguarded `toDate`, which is pinned separately below).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { num, toDate, maxDate } from "@/lib/admin-metrics";

describe("num", () => {
  const table: Array<[unknown, number]> = [
    [5, 5], ["5", 5], ["12345678901", 12345678901], [" 7 ", 7], ["1e3", 1000], [0, 0], [-3, -3],
    [null, 0], [undefined, 0], ["", 0], ["abc", 0], [NaN, 0], [Infinity, 0], [-Infinity, 0],
    ["Infinity", 0], [true, 1], [false, 0], [[], 0], [{}, 0],
  ];
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(num(input as never), expected);
    });
  }
});

describe("toDate", () => {
  const d = new Date("2026-03-04T05:06:07.089Z");
  it("returns valid Dates by identity", () => assert.equal(toDate(d), d));
  it("parses strings", () => {
    assert.equal(toDate("2026-03-04T05:06:07.089Z")?.getTime(), d.getTime());
    assert.equal(toDate("2026-03-04 05:06:07.089+00")?.getTime(), d.getTime());
  });
  it("null/undefined -> null", () => {
    assert.equal(toDate(null), null);
    assert.equal(toDate(undefined), null);
  });
  it("NaN guard: invalid Date and unparseable string -> null (admin-trends used to return Invalid Date)", () => {
    assert.equal(toDate(new Date("nope")), null);
    assert.equal(toDate("not a date"), null);
    assert.equal(toDate(""), null);
  });
});

describe("maxDate", () => {
  it("picks the latest valid value, ignoring junk", () => {
    const got = maxDate(null, "2026-01-01T00:00:00Z", new Date("2026-03-01T00:00:00Z"), "junk", undefined);
    assert.equal(got?.toISOString(), "2026-03-01T00:00:00.000Z");
  });
  it("is null when nothing is valid", () => {
    assert.equal(maxDate(), null);
    assert.equal(maxDate(null, "junk"), null);
  });
});
