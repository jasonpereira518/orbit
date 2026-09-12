/**
 * API key issuance and verification.
 *
 * The properties here are the ones whose absence is a security bug rather than a defect: the
 * plaintext key must not be recoverable from the row, a revoked key must stop working
 * immediately, a read key must not be able to write, and a suspended or unentitled account
 * must not be reachable through a key that is otherwise perfectly valid.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  bearerFrom,
  generateApiKey,
  hashApiKey,
  hashesMatch,
  looksLikeApiKey,
} from "../src/lib/api/keys";
import { ApiAuthError, requireApiCaller, touchApiKeyLastUsed } from "../src/lib/api/auth";
import { isPaywallError, requireEntitlement } from "../src/lib/entitlements";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "api-key-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function req(token: string | null): Request {
  return new Request("https://orbit.test/api/v1/contacts", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function insertKey(opts: {
  scopes?: Array<"read" | "write">;
  revoked?: boolean;
  userId?: string;
}): Promise<string> {
  const db = await getDb();
  const key = generateApiKey();
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes, revoked_at)
    VALUES (
      ${opts.userId ?? USER}, 'smoke key', 'api', ${key.prefix}, ${key.keyHash},
      ${JSON.stringify(opts.scopes ?? ["read", "write"])}::jsonb,
      ${opts.revoked ? new Date() : null}
    )
  `);
  return key.token;
}

async function reason(token: string | null, scope: "read" | "write" = "read"): Promise<string> {
  try {
    await requireApiCaller(req(token), { scope });
    return "allowed";
  } catch (err) {
    return err instanceof ApiAuthError ? err.reason : `unexpected:${String(err)}`;
  }
}

/**
 * The entitlement half of `createApiKey`, exercised without a request context.
 *
 * The action itself calls `requireUserId()` and `revalidatePath()`, neither of which exists in
 * a `tsx` script, so this reproduces the branch that matters: refuse-with-data rather than
 * throw. If the action's guard changes shape, this is what should be updated alongside it.
 */
async function createApiKeyFor(userId: string) {
  try {
    await requireEntitlement(userId, "api");
    return { ok: true as const };
  } catch (err) {
    if (isPaywallError(err)) {
      return { ok: false as const, reason: "payment_required", message: err.message };
    }
    throw err;
  }
}

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM api_keys WHERE user_id LIKE 'api-key-smoke%'`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id LIKE 'api-key-smoke%'`);

  // --- Format and hashing -----------------------------------------------------------------
  const generated = generateApiKey();
  check("a generated key matches the expected shape", looksLikeApiKey(generated.token), generated.token.slice(0, 20));
  check("the prefix is a strict prefix of the token", generated.token.startsWith(generated.prefix));
  check(
    "the stored hash is not the token",
    generated.keyHash !== generated.token && generated.keyHash.length === 64
  );
  check("hashing is deterministic", hashApiKey(generated.token) === generated.keyHash);
  check("two keys never collide", generateApiKey().token !== generateApiKey().token);
  check("an mcp_url key is distinguishable", generateApiKey("mcp_url").token.startsWith("mcpk_live_"));
  check("hashesMatch accepts equal digests", hashesMatch(generated.keyHash, generated.keyHash));
  check("hashesMatch rejects different digests", !hashesMatch(generated.keyHash, hashApiKey("other")));
  check("a random string is not mistaken for a key", !looksLikeApiKey("orb_live_nope"));
  check("bearerFrom reads the header", bearerFrom("Bearer abc") === "abc");
  check("bearerFrom tolerates casing", bearerFrom("bearer abc") === "abc");
  check("bearerFrom rejects a bare value", bearerFrom("abc") === null);

  // --- The plaintext key must not be recoverable from the database ---------------------------
  const token = await insertKey({});
  const stored = rowsOf<{ row: string }>(
    await db.execute(sql`
      SELECT to_jsonb(api_keys)::text AS row FROM api_keys WHERE user_id = ${USER} LIMIT 1
    `)
  )[0];
  const secret = token.split("_").pop() as string;
  check(
    "the row contains no part of the secret",
    !stored.row.includes(secret),
    stored.row.slice(0, 60)
  );

  // --- The paywall applies to a perfectly valid key ----------------------------------------
  // Checked BEFORE comping the account, so the free-plan refusal is exercised for real rather
  // than assumed. `gate_events` is deliberately not written on this path — see auth.ts.
  check(
    "a valid key on a free plan is refused for payment",
    (await reason(token)) === "payment_required"
  );
  await db.execute(sql`
    UPDATE user_settings SET comped_plan = 'orbit', comped_at = now() WHERE user_id = ${USER}
  `);

  // --- Verification ---------------------------------------------------------------------------
  check("no credential at all", (await reason(null)) === "missing");
  check("a malformed credential is rejected on shape", (await reason("garbage")) === "malformed");
  check(
    "a well-formed key that does not exist",
    (await reason(generateApiKey().token)) === "unknown"
  );
  check("a valid key is accepted", (await reason(token)) === "allowed");

  const caller = await requireApiCaller(req(token), { scope: "read" });
  check("the caller resolves to the owning user", caller.userId === USER, caller.userId);
  check("the caller carries the key id for attribution", Boolean(caller.keyId));

  // --- Revocation is immediate -------------------------------------------------------------------
  const revoked = await insertKey({ revoked: true });
  check("a revoked key stops working", (await reason(revoked)) === "revoked");

  // --- Scope --------------------------------------------------------------------------------------
  const readOnly = await insertKey({ scopes: ["read"] });
  check("a read key may read", (await reason(readOnly, "read")) === "allowed");
  check(
    "a read key may NOT write",
    (await reason(readOnly, "write")) === "insufficient_scope"
  );
  check("a read+write key may write", (await reason(token, "write")) === "allowed");

  // --- Suspension closes the door even with a valid key -----------------------------------------
  await db.execute(sql`
    UPDATE user_settings SET suspended_at = now() WHERE user_id = ${USER}
  `);
  check("a suspended account cannot use its key", (await reason(token)) === "suspended");
  await db.execute(sql`UPDATE user_settings SET suspended_at = NULL WHERE user_id = ${USER}`);
  check("clearing the suspension restores access", (await reason(token)) === "allowed");

  // --- last_used_at is throttled, not written per request ------------------------------------------
  await db.execute(sql`UPDATE api_keys SET last_used_at = NULL WHERE user_id = ${USER}`);
  const keyId = rowsOf<{ id: string }>(
    await db.execute(sql`SELECT id FROM api_keys WHERE key_hash = ${hashApiKey(token)}`)
  )[0].id;
  await touchApiKeyLastUsed(keyId);
  const first = rowsOf<{ last_used_at: string | null }>(
    await db.execute(sql`SELECT last_used_at FROM api_keys WHERE id = ${keyId}`)
  )[0].last_used_at;
  check("the first use stamps last_used_at", first !== null);
  await touchApiKeyLastUsed(keyId);
  const second = rowsOf<{ last_used_at: string | null }>(
    await db.execute(sql`SELECT last_used_at FROM api_keys WHERE id = ${keyId}`)
  )[0].last_used_at;
  check(
    "an immediate second use does not write again",
    String(first) === String(second),
    `${first} vs ${second}`
  );

  // --- The paywall is REPORTED, not thrown, across the server-action boundary ---------------
  // Next redacts a thrown action error's message before it reaches the browser, so a paywall
  // that throws reaches the UI as an opaque digest and can only be rendered as "something went
  // wrong" — the least useful thing to say to someone who just needs to upgrade. The refusal
  // is therefore returned as data. The demand signal survives either way, because
  // `requireEntitlement` writes the gate_events row before it throws.
  const free = "api-key-smoke-free";
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${free}`);
  await db.execute(sql`DELETE FROM gate_events WHERE user_id = ${free}`);
  await ensureUserSettings(free);
  const refusal = await createApiKeyFor(free);
  check("a free plan gets a structured refusal, not a throw", refusal.ok === false, JSON.stringify(refusal));
  check(
    "the refusal carries a message the UI can show",
    refusal.ok === false && refusal.message.toLowerCase().includes("orbit pro"),
    refusal.ok === false ? refusal.message : ""
  );
  const gateRows = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM gate_events WHERE user_id = ${free} AND feature = 'api'
    `)
  )[0];
  check(
    "the refusal still records the demand signal in gate_events",
    Number(gateRows.n) === 1,
    String(gateRows.n)
  );
  await db.execute(sql`DELETE FROM gate_events WHERE user_id = ${free}`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${free}`);

  await db.execute(sql`DELETE FROM api_keys WHERE user_id LIKE 'api-key-smoke%'`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll API key checks passed.");
});
