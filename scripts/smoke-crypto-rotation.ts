/**
 * Secrets rotation and derivation (FIX_PLAN 3.6, audit L-06 / L-05).
 *
 *  - Every ciphertext format ever written still decrypts: a FROZEN legacy value produced by
 *    the pre-v2 algorithm outside the app code, plus fresh legacy values.
 *  - v2 round-trips, carries its key id, and the id is bound into the tag.
 *  - With ENCRYPTION_SECRET_PREVIOUS set, values under the old secret decrypt and are
 *    re-encrypted in place on read (against a real PGlite row), and current values are left.
 *  - Unsubscribe links signed before the HKDF sub-keys (frozen tokens) still verify, under
 *    the current secret and, after a rotation, under the previous one; new tokens differ.
 *  - Hash binding of the credit-email token; OAuth state and rate-limit key fallbacks.
 *  - Non-production fallbacks throw on Vercel.
 *
 * Run: npx tsx scripts/smoke-crypto-rotation.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { getDb } from "../src/db";
import { userSettings, webhookEndpoints } from "../src/db/schema";
import { legacyIpBucketKey, ipBucketKey } from "../src/lib/client-ip";
import { parseOAuthState, signOAuthState } from "../src/lib/connectors/oauth";
import {
  creditEmailUnsubscribeToken,
  readCreditEmailUnsubscribeToken,
  unsubscribeCreditEmail,
} from "../src/lib/credits/notices";
import {
  decrypt,
  decryptOrNull,
  decryptWithStatus,
  encrypt,
  encryptLegacyForTest,
  isCurrentCiphertext,
  keyIdFor,
} from "../src/lib/crypto";
import { decryptAndRewrap, setRewrapWriterForTest } from "../src/lib/crypto-rewrap";
import { radarDigestUnsubscribeToken, readRadarDigestUnsubscribeToken } from "../src/lib/radar/digest";
import { DEV_ENCRYPTION_FALLBACK, encryptionSecret } from "../src/lib/secrets";
import { hashIdToken } from "../src/lib/signed-id-token";
import { run } from "./smoke/_env";

/** Test values only — never a real secret. */
const FIXTURE_SECRET = "smoke-rotation-fixture-secret-0123456789abcdef";
const NEW_SECRET = "smoke-rotation-new-secret-fedcba9876543210-xyz";

/**
 * Made by the pre-v2 code path (scrypt(secret, "orbit-salt"), `iv:tag:data` hex) in a
 * standalone script, not by anything in `src/`, so a change to the app's legacy reader
 * cannot quietly regenerate its own expectations.
 */
const FROZEN_LEGACY_CIPHERTEXT =
  "000102030405060708090a0b:19d84d4803217f7f6708bb7b37f80971:055d0ea6b5e5447f2f2af73187b5313cd3c05c280d5f7f817cd83f";
const FROZEN_LEGACY_PLAINTEXT = "sk-legacy-fixture-plaintext";
/** `base64url("user_fixture").HMAC(HMAC(secret, label), id)` — the shape every sent email carries. */
const FROZEN_CREDIT_TOKEN = "dXNlcl9maXh0dXJl.AP_Ki3uX8EDbSYgnCfnBCvNHp_k7k8PiVPu1aBTUuGo";
const FROZEN_RADAR_TOKEN = "dXNlcl9maXh0dXJl.awzZvKah3wqlUe526_g8xKDT1-O6VfsbRY27pgIknWw";

const USER = "smoke-crypto-rotation-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function useSecrets(current: string | undefined, previous?: string) {
  if (current === undefined) delete process.env.ENCRYPTION_SECRET;
  else process.env.ENCRYPTION_SECRET = current;
  if (previous === undefined) delete process.env.ENCRYPTION_SECRET_PREVIOUS;
  else process.env.ENCRYPTION_SECRET_PREVIOUS = previous;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

run(async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedVercel = process.env.VERCEL;
  delete process.env.VERCEL;
  if (process.env.NODE_ENV === "production") (process.env as Record<string, string>).NODE_ENV = "test";

  console.log("Legacy ciphertext");
  useSecrets(FIXTURE_SECRET);
  const frozen = decryptWithStatus(FROZEN_LEGACY_CIPHERTEXT);
  check("a frozen pre-v2 ciphertext decrypts", frozen.plaintext === FROZEN_LEGACY_PLAINTEXT);
  check("…and is reported stale, so it gets re-encrypted", frozen.stale);
  const freshLegacy = encryptLegacyForTest("another legacy value");
  check("a fresh legacy value round-trips", decrypt(freshLegacy) === "another legacy value");
  check("decryptOrNull still nulls garbage and empties", decryptOrNull("ciphertext") === null && decryptOrNull(null) === null && decryptOrNull("") === null);

  console.log("\nv2");
  const v2 = encrypt("sk-v2-plaintext");
  const [version, kid] = v2.split(":");
  check("new ciphertext is v2 with the current key id", version === "v2" && kid === keyIdFor(FIXTURE_SECRET), v2.slice(0, 12));
  check("v2 round-trips and is current", decrypt(v2) === "sk-v2-plaintext" && !decryptWithStatus(v2).stale && isCurrentCiphertext(v2));
  check("two encryptions differ (random IV)", encrypt("same") !== encrypt("same"));
  const swappedKid = v2.replace(`v2:${kid}:`, "v2:00000000:");
  check("the key id is bound into the tag: editing it fails", decryptOrNull(swappedKid) === null);
  const flipped = v2.slice(0, -2) + (v2.endsWith("00") ? "11" : "00");
  check("a tampered body fails", decryptOrNull(flipped) === null);
  check("non-ASCII survives", decrypt(encrypt("ключ 🔑")) === "ключ 🔑");

  console.log("\nRotation: ENCRYPTION_SECRET_PREVIOUS");
  const v2Old = encrypt("written-under-the-old-secret");
  useSecrets(NEW_SECRET);
  check("without the previous secret, old values do not decrypt", decryptOrNull(v2Old) === null && decryptOrNull(FROZEN_LEGACY_CIPHERTEXT) === null);
  useSecrets(NEW_SECRET, FIXTURE_SECRET);
  const viaPrevious = decryptWithStatus(v2Old);
  check("a v2 value under the previous secret decrypts", viaPrevious.plaintext === "written-under-the-old-secret");
  check("…and is stale", viaPrevious.stale);
  check("a legacy value under the previous secret decrypts", decrypt(FROZEN_LEGACY_CIPHERTEXT) === FROZEN_LEGACY_PLAINTEXT);
  check("new values use the new secret's key id", encrypt("x").split(":")[1] === keyIdFor(NEW_SECRET));
  check("ENCRYPTION_SECRET_PREVIOUS equal to the current one is ignored", (() => {
    useSecrets(NEW_SECRET, NEW_SECRET);
    const ok = decryptOrNull(v2Old) === null;
    useSecrets(NEW_SECRET, FIXTURE_SECRET);
    return ok;
  })());

  console.log("\nLazy re-encryption on read");
  const writes: Array<{ stored: string; fresh: string }> = [];
  setRewrapWriterForTest(async (_t, stored, fresh) => {
    writes.push({ stored, fresh });
  });
  const target = { table: webhookEndpoints, column: webhookEndpoints.secretEncrypted, idColumn: webhookEndpoints.id, id: "00000000-0000-0000-0000-000000000000" };
  check("a stale value is returned in plaintext", (await decryptAndRewrap(v2Old, target)) === "written-under-the-old-secret");
  check("…and rewritten once, under the new secret", writes.length === 1 && writes[0].stored === v2Old && isCurrentCiphertext(writes[0].fresh) && decrypt(writes[0].fresh) === "written-under-the-old-secret");
  writes.length = 0;
  const current = encrypt("already current");
  await decryptAndRewrap(current, target);
  check("a current value is not rewritten", writes.length === 0);
  check("an undecryptable value reads as null and writes nothing", (await decryptAndRewrap("not-a-ciphertext", target)) === null && writes.length === 0);
  setRewrapWriterForTest(async () => {
    throw new Error("database down");
  });
  check("a failed rewrite still returns the plaintext", (await decryptAndRewrap(FROZEN_LEGACY_CIPHERTEXT, target)) === FROZEN_LEGACY_PLAINTEXT);
  setRewrapWriterForTest(null);

  // Against a real row: the compare-and-swap lands, and a second read finds nothing to do.
  await cleanup();
  const db = await getDb();
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({ userId: USER, url: "https://example.test/hook", secretEncrypted: FROZEN_LEGACY_CIPHERTEXT })
    .returning();
  const read = await decryptAndRewrap(endpoint.secretEncrypted, { ...target, id: endpoint.id });
  const [after] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
  check("PGlite: the legacy row is read", read === FROZEN_LEGACY_PLAINTEXT);
  check("PGlite: and now holds current v2 ciphertext of the same value", isCurrentCiphertext(after.secretEncrypted) && decrypt(after.secretEncrypted) === FROZEN_LEGACY_PLAINTEXT);
  // A concurrent writer got there first: the swap must not overwrite it.
  await db.update(webhookEndpoints).set({ secretEncrypted: encryptLegacyForTest("old", FIXTURE_SECRET) }).where(eq(webhookEndpoints.id, endpoint.id));
  const [stale] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
  const newer = encrypt("rotated by someone else");
  await db.update(webhookEndpoints).set({ secretEncrypted: newer }).where(eq(webhookEndpoints.id, endpoint.id));
  await decryptAndRewrap(stale.secretEncrypted, { ...target, id: endpoint.id });
  const [kept] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
  check("PGlite: a rewrite never clobbers a value written since it was read", kept.secretEncrypted === newer);

  console.log("\nUnsubscribe links already in inboxes");
  useSecrets(FIXTURE_SECRET);
  check("a frozen credit-email token still names its account", readCreditEmailUnsubscribeToken(FROZEN_CREDIT_TOKEN) === "user_fixture");
  check("a frozen Radar token still names its account", readRadarDigestUnsubscribeToken(FROZEN_RADAR_TOKEN) === "user_fixture");
  const fresh = creditEmailUnsubscribeToken("user_fixture");
  check("new tokens come from the HKDF sub-key, not the raw secret", fresh !== FROZEN_CREDIT_TOKEN && readCreditEmailUnsubscribeToken(fresh) === "user_fixture");
  check("a credit token is not a Radar token (labels separate them)", readRadarDigestUnsubscribeToken(fresh) === null && readCreditEmailUnsubscribeToken(radarDigestUnsubscribeToken("user_fixture")) === null);
  check("a forged mac names nobody", readCreditEmailUnsubscribeToken(FROZEN_CREDIT_TOKEN.replace(/.$/, "x")) === null);
  check("the raw secret used directly as the key does not verify", (() => {
    const id = Buffer.from("user_fixture").toString("base64url");
    return readCreditEmailUnsubscribeToken(`${id}.${createHmac("sha256", FIXTURE_SECRET).update(id).digest("base64url")}`) === null;
  })());
  useSecrets(NEW_SECRET, FIXTURE_SECRET);
  check("after a rotation, frozen links verify through the previous secret", readCreditEmailUnsubscribeToken(FROZEN_CREDIT_TOKEN) === "user_fixture" && readRadarDigestUnsubscribeToken(FROZEN_RADAR_TOKEN) === "user_fixture");
  check("…and so do links signed under the old secret's sub-key", readCreditEmailUnsubscribeToken(fresh) === "user_fixture");
  useSecrets(NEW_SECRET);
  check("once the previous secret is removed, they stop", readCreditEmailUnsubscribeToken(FROZEN_CREDIT_TOKEN) === null);

  console.log("\nCredit-email token is hash-bound (L-05)");
  useSecrets(FIXTURE_SECRET);
  await db.insert(userSettings).values({ userId: USER, email: "rotation@example.test" });
  const bound = creditEmailUnsubscribeToken(USER);
  check("a new token with no stored hash does nothing", !(await unsubscribeCreditEmail(bound)));
  await db.update(userSettings).set({ creditEmailUnsubTokenHash: hashIdToken(bound) }).where(eq(userSettings.userId, USER));
  check("with its hash on the account it unsubscribes", await unsubscribeCreditEmail(bound));
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, USER));
  check("…and the switch is off", settings.creditEmailEnabled === 0);
  await db.update(userSettings).set({ creditEmailEnabled: 1, creditEmailUnsubTokenHash: null }).where(eq(userSettings.userId, USER));
  const legacyForUser = (() => {
    const id = Buffer.from(USER).toString("base64url");
    const key = createHmac("sha256", FIXTURE_SECRET).update("orbit:credit-email-unsubscribe:v1").digest();
    return `${id}.${createHmac("sha256", key).update(id).digest("base64url")}`;
  })();
  check("a legacy token (mailed before hashes were stored) still unsubscribes", await unsubscribeCreditEmail(legacyForUser));

  console.log("\nOAuth state and rate-limit keys");
  process.env.HUBSPOT_CLIENT_ID = "test-client";
  const state = signOAuthState({ userId: "u1", connectorId: "hubspot", returnTo: "/settings" });
  check("a state signed now parses", parseOAuthState(state)?.userId === "u1");
  useSecrets(NEW_SECRET, FIXTURE_SECRET);
  check("…and still parses right after a rotation", parseOAuthState(state)?.userId === "u1");
  useSecrets(NEW_SECRET);
  check("…but not once the previous secret is gone", parseOAuthState(state) === null);
  delete process.env.ANALYTICS_SALT;
  check("rate-limit keys moved off the raw secret", ipBucketKey("203.0.113.9") !== legacyIpBucketKey("203.0.113.9"));
  check("…and are stable per IP", ipBucketKey("203.0.113.9") === ipBucketKey("203.0.113.9") && ipBucketKey("203.0.113.9") !== ipBucketKey("203.0.113.10"));

  console.log("\nFallback secrets");
  useSecrets(undefined);
  check("off Vercel, the dev fallback is used", encryptionSecret() === DEV_ENCRYPTION_FALLBACK && decrypt(encrypt("dev")) === "dev");
  process.env.VERCEL = "1";
  check("on Vercel without ENCRYPTION_SECRET, encrypt refuses", throws(() => encrypt("x")));
  check("…as do token signing and the rate-limit key", throws(() => creditEmailUnsubscribeToken("u")) && throws(() => ipBucketKey("203.0.113.9")));
  delete process.env.VERCEL;
  (process.env as Record<string, string>).NODE_ENV = "production";
  check("in production without it, encrypt refuses", throws(() => encrypt("x")));
  if (savedNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string>).NODE_ENV = savedNodeEnv;
  if (savedVercel !== undefined) process.env.VERCEL = savedVercel;

  await cleanup();
  if (failures > 0) throw new Error(`${failures} crypto-rotation check(s) failed`);
  console.log("\nAll crypto-rotation checks passed.");
});
