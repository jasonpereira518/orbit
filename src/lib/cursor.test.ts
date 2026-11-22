/**
 * Characterization of the keyset cursor formats (plan P4.6). Literal strings were captured
 * from the code BEFORE it moved to `lib/cursor.ts`; cursors are held by external callers
 * (the public v1 API) and open browser tabs, so every one must keep decoding and encoding
 * byte-for-byte. The `LEGACY_*` functions are the pre-migration bodies, copied verbatim, and
 * are fuzzed against the helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeIsoIdCursor,
  decodeJsonCursor,
  decodePgTimestampIdCursor,
  encodeIsoIdCursor,
  encodeJsonCursor,
} from "@/lib/cursor";

const ID = "3f2b8c1e-9a47-4d6e-8b21-0c5d7e9a1f34";

/** app/api/v1/contacts/route.ts (verbatim) */
function legacyV1Encode(row: { createdAt: Date | null; id: string }): string {
  return Buffer.from(`${(row.createdAt ?? new Date(0)).toISOString()}|${row.id}`).toString("base64url");
}
function legacyV1Decode(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** lib/capture-history.ts and lib/meetings-list.ts (verbatim; the two were identical) */
function legacyPlainDecode(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(at)) return null;
  return { at, id };
}

/** lib/reminders-page-query.ts and lib/contacts-page-cursor.ts (verbatim encode/parse) */
function legacyJsonEncode(cursor: unknown): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
function legacyJsonParse(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** v1 route's decode, expressed through the shared helper (what the route now does). */
function v1Decode(cursor: string) {
  const parts = decodeIsoIdCursor(cursor, "base64url");
  if (!parts) return null;
  const createdAt = new Date(parts.iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: parts.id };
}

const JUNK = [
  "", "|", "a|", "|a", "a|b|c", "!!!", "not a cursor", "%%%|%%%", ID,
  `2026-03-04T05:06:07.089Z|${ID}`, `2026-03-04 05:06:07.123456+00|${ID}`,
  `2026-03-04T05:06:07Z|${ID}|extra`, `garbage|${ID}`, `2026-03-04T05:06:07.089Z|not-a-uuid`,
  `2026-03-04 05:06:07.1234567+00|${ID}`, "\u0000|\u0000", "💥|💥",
];

describe("v1 contacts cursor (base64url iso|id): PUBLIC API", () => {
  it("encodes to the exact literal strings external callers already hold", () => {
    assert.equal(
      encodeIsoIdCursor("2026-03-04T05:06:07.089Z", ID, "base64url"),
      "MjAyNi0wMy0wNFQwNTowNjowNy4wODlafDNmMmI4YzFlLTlhNDctNGQ2ZS04YjIxLTBjNWQ3ZTlhMWYzNA"
    );
    assert.equal(
      encodeIsoIdCursor(new Date(0).toISOString(), ID, "base64url"),
      "MTk3MC0wMS0wMVQwMDowMDowMC4wMDBafDNmMmI4YzFlLTlhNDctNGQ2ZS04YjIxLTBjNWQ3ZTlhMWYzNA"
    );
  });

  it("decodes the literal strings", () => {
    const got = v1Decode("MjAyNi0wMy0wNFQwNTowNjowNy4wODlafDNmMmI4YzFlLTlhNDctNGQ2ZS04YjIxLTBjNWQ3ZTlhMWYzNA");
    assert.deepEqual(got, { createdAt: new Date("2026-03-04T05:06:07.089Z"), id: ID });
  });

  it("matches the legacy codec on valid and junk input", () => {
    for (const createdAt of [new Date("2026-03-04T05:06:07.089Z"), new Date(0), null]) {
      const enc = legacyV1Encode({ createdAt, id: ID });
      assert.equal(encodeIsoIdCursor((createdAt ?? new Date(0)).toISOString(), ID, "base64url"), enc);
      assert.deepEqual(v1Decode(enc), legacyV1Decode(enc));
    }
    for (const j of JUNK) {
      assert.deepEqual(v1Decode(j), legacyV1Decode(j), JSON.stringify(j));
      const b64 = Buffer.from(j).toString("base64url");
      assert.deepEqual(v1Decode(b64), legacyV1Decode(b64), `b64 ${JSON.stringify(j)}`);
    }
  });
});

describe("capture-history / meetings-list cursor (plain pg-text|id)", () => {
  it("encodes plainly", () => {
    assert.equal(
      encodeIsoIdCursor("2026-03-04 05:06:07.123456+00", ID, "plain"),
      `2026-03-04 05:06:07.123456+00|${ID}`
    );
  });
  it("decodes the literal forms", () => {
    assert.deepEqual(decodePgTimestampIdCursor(`2026-03-04 05:06:07.123456+00|${ID}`), {
      at: "2026-03-04 05:06:07.123456+00",
      id: ID,
    });
    assert.deepEqual(decodePgTimestampIdCursor(`2026-03-04T05:06:07Z|${ID.toUpperCase()}`), {
      at: "2026-03-04T05:06:07Z",
      id: ID.toUpperCase(),
    });
    assert.equal(decodePgTimestampIdCursor(null), null);
    assert.equal(decodePgTimestampIdCursor(undefined), null);
  });
  it("matches the legacy decoder on valid and junk input", () => {
    for (const j of JUNK) {
      assert.deepEqual(decodePgTimestampIdCursor(j), legacyPlainDecode(j), JSON.stringify(j));
    }
  });
});

describe("reminders / contacts-page cursor (base64url JSON)", () => {
  const cases: Array<[unknown, string]> = [
    [
      { v: "a", d: "2026-03-04", t: "2026-03-04 05:06:07.123456+00", id: ID },
      "eyJ2IjoiYSIsImQiOiIyMDI2LTAzLTA0IiwidCI6IjIwMjYtMDMtMDQgMDU6MDY6MDcuMTIzNDU2KzAwIiwiaWQiOiIzZjJiOGMxZS05YTQ3LTRkNmUtOGIyMS0wYzVkN2U5YTFmMzQifQ",
    ],
    [
      { v: "d", c: "2026-03-04T05:06:07.089Z", id: ID },
      "eyJ2IjoiZCIsImMiOiIyMDI2LTAzLTA0VDA1OjA2OjA3LjA4OVoiLCJpZCI6IjNmMmI4YzFlLTlhNDctNGQ2ZS04YjIxLTBjNWQ3ZTlhMWYzNCJ9",
    ],
    [
      { s: "name", k: "smith", n: "Ann Smith", id: ID, t: 1 },
      "eyJzIjoibmFtZSIsImsiOiJzbWl0aCIsIm4iOiJBbm4gU21pdGgiLCJpZCI6IjNmMmI4YzFlLTlhNDctNGQ2ZS04YjIxLTBjNWQ3ZTlhMWYzNCIsInQiOjF9",
    ],
  ];
  it("encodes to the literals and round-trips", () => {
    for (const [obj, literal] of cases) {
      assert.equal(encodeJsonCursor(obj), literal);
      assert.equal(encodeJsonCursor(obj), legacyJsonEncode(obj));
      assert.deepEqual(decodeJsonCursor(literal), obj);
    }
  });
  it("matches the legacy parse on junk", () => {
    const junk = [...JUNK, undefined, Buffer.from("null").toString("base64url"), Buffer.from("{bad").toString("base64url"), Buffer.from('"s"').toString("base64url")];
    for (const j of junk) {
      assert.deepEqual(decodeJsonCursor(j), legacyJsonParse(j), JSON.stringify(j));
    }
  });
});
