import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { creditEmailUnsubscribeToken, readCreditEmailUnsubscribeToken } from "@/lib/credits/notices";
import { readRadarDigestUnsubscribeToken } from "@/lib/radar/digest";
import { safeEqual, sha256Hex } from "@/lib/crypto";
import { signIdToken, verifyIdToken } from "@/lib/signed-id-token";

const CREDIT_SPEC = { label: "orbit:credit-email-unsubscribe:v1", devFallback: "orbit-dev-credit-email" };
const RADAR_SPEC = { label: "orbit:radar-digest-unsubscribe:v1", devFallback: "orbit-dev-radar-digest" };
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

  it("legacy algorithm reproduces the goldens", () => {
    for (const g of GOLDEN) {
      assert.equal(legacyMint(CREDIT_LABEL, CREDIT_DEV, g.user), g.credit);
      assert.equal(legacyMint(RADAR_LABEL, RADAR_DEV, g.user), g.radar);
    }
  });

  it("verifyToken accepts tokens minted by the legacy code, and reads match", () => {
    for (const g of GOLDEN) {
      assert.equal((verifyIdToken(CREDIT_SPEC, g.credit)?.id ?? null), g.user);
      assert.equal((verifyIdToken(RADAR_SPEC, g.radar)?.id ?? null), g.user);
      assert.equal(readCreditEmailUnsubscribeToken(g.credit), g.user);
      assert.equal(readRadarDigestUnsubscribeToken(g.radar), g.user);
      assert.equal(legacyRead(CREDIT_LABEL, CREDIT_DEV, g.credit), g.user);
    }
  });

  it("rejects wrong label, cross-purpose, tampering and bad shapes", () => {
    const g = GOLDEN[0];
    assert.equal((verifyIdToken(RADAR_SPEC, g.credit)?.id ?? null), null);
    assert.equal(readRadarDigestUnsubscribeToken(g.credit), null);
    assert.equal(readCreditEmailUnsubscribeToken(g.radar), null);
    const [id, mac] = g.credit.split(".");
    assert.equal((verifyIdToken(CREDIT_SPEC, `${id}.${mac.slice(0, -1)}A`)?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, `${id}.${mac.slice(1)}`)?.id ?? null), null); // wrong length
    assert.equal((verifyIdToken(CREDIT_SPEC, `${id}.${mac}x`)?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, `${id}.${mac}.extra`)?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, `${Buffer.from("other").toString("base64url")}.${mac}`)?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, "")?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, null)?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, undefined)?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, "nodot")?.id ?? null), null);
    assert.equal((verifyIdToken(CREDIT_SPEC, "a".repeat(401))?.id ?? null), null);
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
      assert.throws(() => signIdToken(CREDIT_SPEC, "u"));
      assert.throws(() => (verifyIdToken(CREDIT_SPEC, "a.b")?.id ?? null));
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
