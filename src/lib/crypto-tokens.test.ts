import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { creditEmailUnsubscribeToken, readCreditEmailUnsubscribeToken } from "@/lib/credits/notices";
import { radarDigestUnsubscribeToken, readRadarDigestUnsubscribeToken } from "@/lib/radar/digest";
import { safeEqual, sha256Hex, signToken, verifyToken } from "@/lib/crypto";

const SECRET = "test-secret-test-secret-test-secret-0123";
const CREDIT_LABEL = "orbit:credit-email-unsubscribe:v1";
const RADAR_LABEL = "orbit:radar-digest-unsubscribe:v1";
const CREDIT_DEV = "orbit-dev-credit-email";
const RADAR_DEV = "orbit-dev-radar-digest";

// Golden tokens minted by the pre-consolidation code (notices.ts / digest.ts) at SECRET.
const GOLDEN: Array<{ user: string; credit: string; radar: string }> = [
  {
    user: "user_2abcDEF",
    credit: "dXNlcl8yYWJjREVG.Whwez3FByAW5dDBDBm_T-eg4r4UJeDGkiN7Qd9SXphs",
    radar: "dXNlcl8yYWJjREVG.bldHiIyC4MOcsHgm03evSQR1bGaMjQJhC88v2oGngo4",
  },
  {
    user: "üser/with spaces+é",
    credit: "w7xzZXIvd2l0aCBzcGFjZXMrw6k.tvXCik2b1-3e3UMb6HsrF5oCWhRB_X0v4yQLZPNqYeU",
    radar: "w7xzZXIvd2l0aCBzcGFjZXMrw6k.GzgyA8EekRRIeMPTqQ6MnxDHdBuaLMJ1rryfNqgo-TY",
  },
];
// Same, with ENCRYPTION_SECRET unset (the dev fallbacks).
const GOLDEN_DEV = [
  {
    user: "user_2abcDEF",
    credit: "dXNlcl8yYWJjREVG.AObxdWd4xCB8EOsx9PoapLGcz_DC5o63IJgvbiqPulI",
    radar: "dXNlcl8yYWJjREVG.ZWe6Ft3JxhAa6MviUiyg_AuhFmxiaVaMDBoB41dQTXY",
  },
];

// LEGACY: verbatim copy of the algorithm that lived (twice) in credits/notices.ts and
// radar/digest.ts before consolidation. Kept so tokens minted by old code are proven to verify.
function legacyKey(label: string, devSecret: string): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("ENCRYPTION_SECRET must be set in production");
  return createHmac("sha256", secret || devSecret).update(label).digest();
}
function legacyMint(label: string, devSecret: string, userId: string): string {
  const id = Buffer.from(userId, "utf8").toString("base64url");
  const mac = createHmac("sha256", legacyKey(label, devSecret)).update(id).digest("base64url");
  return `${id}.${mac}`;
}
function legacyRead(label: string, devSecret: string, token: string | null | undefined): string | null {
  if (!token || token.length > 400) return null;
  const [id, mac, extra] = token.split(".");
  if (!id || !mac || extra !== undefined) return null;
  const expected = Buffer.from(createHmac("sha256", legacyKey(label, devSecret)).update(id).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Buffer.from(id, "base64url").toString("utf8") || null;
}

describe("unsubscribe tokens", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ENCRYPTION_SECRET;
    process.env.ENCRYPTION_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = saved;
  });

  it("public mint functions produce the literal golden tokens", () => {
    for (const g of GOLDEN) {
      assert.equal(creditEmailUnsubscribeToken(g.user), g.credit);
      assert.equal(radarDigestUnsubscribeToken(g.user), g.radar);
    }
  });

  it("legacy algorithm reproduces the goldens", () => {
    for (const g of GOLDEN) {
      assert.equal(legacyMint(CREDIT_LABEL, CREDIT_DEV, g.user), g.credit);
      assert.equal(legacyMint(RADAR_LABEL, RADAR_DEV, g.user), g.radar);
    }
  });

  it("signToken is byte-identical to the legacy format", () => {
    for (const g of GOLDEN) {
      assert.equal(signToken(CREDIT_LABEL, g.user, CREDIT_DEV), g.credit);
      assert.equal(signToken(RADAR_LABEL, g.user, RADAR_DEV), g.radar);
    }
  });

  it("verifyToken accepts tokens minted by the legacy code, and reads match", () => {
    for (const g of GOLDEN) {
      assert.equal(verifyToken(CREDIT_LABEL, g.credit, CREDIT_DEV), g.user);
      assert.equal(verifyToken(RADAR_LABEL, g.radar, RADAR_DEV), g.user);
      assert.equal(readCreditEmailUnsubscribeToken(g.credit), g.user);
      assert.equal(readRadarDigestUnsubscribeToken(g.radar), g.user);
      assert.equal(legacyRead(CREDIT_LABEL, CREDIT_DEV, g.credit), g.user);
    }
  });

  it("dev fallbacks (no ENCRYPTION_SECRET) are unchanged", () => {
    delete process.env.ENCRYPTION_SECRET;
    for (const g of GOLDEN_DEV) {
      assert.equal(creditEmailUnsubscribeToken(g.user), g.credit);
      assert.equal(radarDigestUnsubscribeToken(g.user), g.radar);
      assert.equal(readCreditEmailUnsubscribeToken(g.credit), g.user);
      assert.equal(verifyToken(RADAR_LABEL, g.radar, RADAR_DEV), g.user);
    }
  });

  it("rejects wrong label, cross-purpose, tampering and bad shapes", () => {
    const g = GOLDEN[0];
    assert.equal(verifyToken(RADAR_LABEL, g.credit, CREDIT_DEV), null);
    assert.equal(readRadarDigestUnsubscribeToken(g.credit), null);
    assert.equal(readCreditEmailUnsubscribeToken(g.radar), null);
    const [id, mac] = g.credit.split(".");
    assert.equal(verifyToken(CREDIT_LABEL, `${id}.${mac.slice(0, -1)}A`, CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, `${id}.${mac.slice(1)}`, CREDIT_DEV), null); // wrong length
    assert.equal(verifyToken(CREDIT_LABEL, `${id}.${mac}x`, CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, `${id}.${mac}.extra`, CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, `${Buffer.from("other").toString("base64url")}.${mac}`, CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, "", CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, null, CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, undefined, CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, "nodot", CREDIT_DEV), null);
    assert.equal(verifyToken(CREDIT_LABEL, "a".repeat(401), CREDIT_DEV), null);
  });

  it("a different secret does not verify", () => {
    const token = creditEmailUnsubscribeToken("user_2abcDEF");
    process.env.ENCRYPTION_SECRET = "another-secret-another-secret-another-9999";
    assert.equal(readCreditEmailUnsubscribeToken(token), null);
  });

  it("refuses to sign or verify in production without ENCRYPTION_SECRET", () => {
    delete process.env.ENCRYPTION_SECRET;
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      assert.throws(() => signToken(CREDIT_LABEL, "u"));
      assert.throws(() => verifyToken(CREDIT_LABEL, "a.b"));
    } finally {
      env.NODE_ENV = prev;
    }
  });
});

describe("safeEqual", () => {
  it("compares strings, including different lengths and non-ASCII", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("", ""), true);
    assert.equal(safeEqual("", "a"), false);
    assert.equal(safeEqual("é", "é"), true);
    assert.equal(safeEqual("é", "e"), false);
    assert.equal(safeEqual("ABCDEF", "abcdef"), false); // case-sensitive
  });
});

describe("sha256Hex", () => {
  it("matches createHash hex of the utf8 string", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const s of ["", "héllo wörld", "a".repeat(1000)]) {
      assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"));
    }
  });
});
