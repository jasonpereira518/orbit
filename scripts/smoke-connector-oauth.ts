/**
 * The generic OAuth2 helper. Pure: every network call is injected.
 *
 * The state parameter carries the return path, so a connect started from a settings deep
 * link comes back to that same pane. It is signed because an unsigned state is an open
 * redirect wearing a seatbelt.
 */
process.env.HUBSPOT_CLIENT_ID = "test-client";
process.env.HUBSPOT_CLIENT_SECRET = "test-secret";
// Deterministic: force the module's dev-secret fallback so the "hand-signed with the real
// secret" checks below can reproduce it without reaching into the module's internals, and so
// this suite behaves the same regardless of what happens to be in the shell environment.
delete process.env.ENCRYPTION_SECRET;
if (process.env.NODE_ENV === "production") {
  (process.env as Record<string, string>).NODE_ENV = "test";
}

import { createHmac } from "crypto";
import {
  OAuthTokenError,
  buildAuthorizeUrl,
  exchangeCode,
  parseOAuthState,
  refreshAccessToken,
  signOAuthState,
} from "../src/lib/connectors/oauth";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Must match oauth.ts's own `stateSecret()` fallback exactly — this is what makes the
// "hand-signed with the REAL secret" checks below meaningful rather than a second copy of
// the "different secret is rejected" check.
const REAL_DEV_SECRET = "orbit-dev-secret-change-me-in-prod";

/**
 * The domain-separation label `oauth.ts` derives its signing subkey with, hardcoded here for
 * the same reason `REAL_DEV_SECRET` is: reproducing the real signature independently is what
 * makes the hand-signed checks below meaningful. Changing the label in the module without
 * changing it here fails these checks, which is correct — it is a signature-format change
 * that invalidates every state in flight.
 */
const STATE_HMAC_LABEL = "orbit:connector-oauth-state:v1";

function stateKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(STATE_HMAC_LABEL).digest();
}

/**
 * Sign a state payload directly, bypassing `signOAuthState` entirely — including its own
 * sanitizing call to `safeReturnTo`. This is the only way to prove that `parseOAuthState`
 * sanitizes independently on the way OUT: `signOAuthState` already sanitizes on the way in,
 * so any check that only ever goes through `signOAuthState` is vacuous for the parse-side
 * guard — deleting it would never make such a check fail. (This is exactly the mutation the
 * security reviewer ran to catch the first version of this suite.)
 */
function signRawState(fields: {
  userId?: string;
  connectorId?: string;
  returnTo: string;
  iat?: number;
  secret?: string;
}): string {
  const payload = {
    userId: fields.userId ?? "u1",
    connectorId: fields.connectorId ?? "hubspot",
    returnTo: fields.returnTo,
    nonce: "test-nonce",
    iat: fields.iat ?? Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateKey(fields.secret ?? REAL_DEV_SECRET))
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${mac}`;
}

const url = buildAuthorizeUrl("hubspot", {
  userId: "u1",
  redirectUri: "https://app.example.com/api/connectors/hubspot/callback",
  scopes: ["crm.objects.contacts.read"],
  returnTo: "/settings?integration=hubspot",
});
const parsed = new URL(url);
check("authorize url points at the provider", parsed.hostname.endsWith("hubspot.com"), parsed.hostname);
check("response_type is code", parsed.searchParams.get("response_type") === "code");
check("scopes are joined", parsed.searchParams.get("scope") === "crm.objects.contacts.read");
check("a state is present", (parsed.searchParams.get("state") ?? "").length > 0);

const state = parseOAuthState(parsed.searchParams.get("state")!);
check("state round-trips the user", state?.userId === "u1");
check("state round-trips the return path", state?.returnTo === "/settings?integration=hubspot");

check("a tampered state is rejected", parseOAuthState("garbage.garbage") === null);
check("null is rejected without throwing", parseOAuthState(null) === null);
check("undefined is rejected without throwing", parseOAuthState(undefined) === null);

const forged = signOAuthState({ userId: "u1", connectorId: "hubspot", returnTo: "https://evil.example" });
check("an absolute return path is refused (sign side)", parseOAuthState(forged)?.returnTo === "/settings");

// A state signed with a different secret must be rejected outright, not just have its
// returnTo sanitized — otherwise a forged state with a fabricated userId/connectorId would
// pass verification as long as its returnTo happened to look safe.
const foreignSigned = signRawState({
  userId: "attacker",
  connectorId: "hubspot",
  returnTo: "/settings",
  secret: "a-different-secret-entirely",
});
check("a state signed with a different secret is rejected", parseOAuthState(foreignSigned) === null);

// --- Parse-side sanitizer: hand-sign with the REAL secret, bypassing signOAuthState's own
// sanitization, so these checks exercise parseOAuthState's independent guard directly. ---

check(
  "parseOAuthState refuses an absolute URL even validly signed",
  parseOAuthState(signRawState({ returnTo: "https://evil.example" }))?.returnTo === "/settings"
);
check(
  "parseOAuthState refuses a protocol-relative path even validly signed",
  parseOAuthState(signRawState({ returnTo: "//evil.example" }))?.returnTo === "/settings"
);

const bypassStrings: Record<string, string> = {
  "backslash after the leading slash": "/\\evil.example",
  "slash-backslash-slash": "/\\/evil.example",
  "tab before the second segment": "/\t/evil.example",
  "newline before the second segment": "/\n/evil.example",
};
for (const [label, bypass] of Object.entries(bypassStrings)) {
  check(
    `parseOAuthState refuses a return path with ${label}`,
    parseOAuthState(signRawState({ returnTo: bypass }))?.returnTo === "/settings"
  );
}

// --- Expiry ---

check(
  "an expired state is rejected",
  parseOAuthState(signRawState({ returnTo: "/settings", iat: Date.now() - 31 * 60 * 1000 })) === null
);
check(
  "a fresh state is accepted",
  parseOAuthState(signRawState({ returnTo: "/settings", iat: Date.now() }))?.returnTo === "/settings"
);

// --- Nonce: two states for identical inputs must differ, or a captured state is replayable
// forever (see the class comment on OAuthState). ---

const stateA = signOAuthState({ userId: "u1", connectorId: "hubspot", returnTo: "/settings" });
const stateB = signOAuthState({ userId: "u1", connectorId: "hubspot", returnTo: "/settings" });
check("two states for identical inputs differ (nonce)", stateA !== stateB);

async function exchange() {
  const ok = await exchangeCode("hubspot", "the-code", "https://app.example.com/cb", {
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 1800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch,
  });
  check("the access token comes back", ok.accessToken === "at");
  check("the refresh token comes back", ok.refreshToken === "rt");
  check("the expiry is absolute", ok.expiresAt instanceof Date && ok.expiresAt > new Date());

  let threw: unknown = null;
  try {
    await exchangeCode("hubspot", "bad", "https://app.example.com/cb", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch,
    });
  } catch (err) {
    threw = err;
  }
  check("a rejected grant throws OAuthTokenError", threw instanceof OAuthTokenError);
  check("the error is marked non-retryable", (threw as OAuthTokenError)?.needsReauth === true);

  // The 4xx/5xx split is what tells the scheduler whether to disarm the connection (dead
  // grant) or back off and retry (provider having a bad day) — getting it backwards would
  // silently strand users on a dead grant that keeps retrying forever, or disarm a
  // connection over a transient provider outage.
  let threw5xx: unknown = null;
  try {
    await exchangeCode("hubspot", "irrelevant", "https://app.example.com/cb", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "server_error" }), { status: 502 })) as typeof fetch,
    });
  } catch (err) {
    threw5xx = err;
  }
  check("a 5xx throws OAuthTokenError", threw5xx instanceof OAuthTokenError);
  check(
    "a 5xx is marked retryable, not needing reauth",
    (threw5xx as OAuthTokenError)?.needsReauth === false
  );

  // A rejected fetch (DNS/TCP failure) must not escape as a raw error — it has to come back
  // through the same retryable/needs-reauth contract as everything else this scheduler acts
  // on, or the most common transient failure silently bypasses that split entirely.
  let threwNetwork: unknown = null;
  try {
    await exchangeCode("hubspot", "irrelevant", "https://app.example.com/cb", {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
  } catch (err) {
    threwNetwork = err;
  }
  check("a fetch rejection throws OAuthTokenError, not a raw error", threwNetwork instanceof OAuthTokenError);
  check(
    "a fetch rejection is retryable, not needing reauth",
    (threwNetwork as OAuthTokenError)?.needsReauth === false
  );

  // The 15s AbortSignal.timeout firing looks like this: fetchImpl rejects with a
  // TimeoutError DOMException, not a normal network TypeError.
  let threwTimeout: unknown = null;
  try {
    await exchangeCode("hubspot", "irrelevant", "https://app.example.com/cb", {
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    });
  } catch (err) {
    threwTimeout = err;
  }
  check("a timeout throws OAuthTokenError, not a raw DOMException", threwTimeout instanceof OAuthTokenError);
  check(
    "a timeout is retryable, not needing reauth",
    (threwTimeout as OAuthTokenError)?.needsReauth === false
  );

  // A provider that 200s an envelope with no access_token is not going to be fixed by
  // retrying — only a fresh consent will produce a real token — so this must land on the
  // needs-reauth side, not spin forever on the retry ladder.
  let threwMalformed: unknown = null;
  try {
    await exchangeCode("hubspot", "irrelevant", "https://app.example.com/cb", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
  } catch (err) {
    threwMalformed = err;
  }
  check("a malformed 2xx body throws OAuthTokenError", threwMalformed instanceof OAuthTokenError);
  check(
    "a malformed 2xx body needs reauth, not a retry",
    (threwMalformed as OAuthTokenError)?.needsReauth === true
  );

  // refreshAccessToken shares postToken with exchangeCode but had no coverage of its own.
  const refreshed = await refreshAccessToken("hubspot", "the-refresh-token", {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ access_token: "at2", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  check("refreshAccessToken returns a new access token", refreshed.accessToken === "at2");

  let threwRefresh: unknown = null;
  try {
    await refreshAccessToken("hubspot", "a-revoked-refresh-token", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch,
    });
  } catch (err) {
    threwRefresh = err;
  }
  check("refreshAccessToken 4xx throws OAuthTokenError", threwRefresh instanceof OAuthTokenError);
  check(
    "refreshAccessToken 4xx needs reauth",
    (threwRefresh as OAuthTokenError)?.needsReauth === true
  );
}

exchange().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector OAuth checks passed.");
  process.exit(0);
});
