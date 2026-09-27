/**
 * The generic OAuth2 helper. Pure: every network call is injected.
 *
 * The state parameter carries the return path, so a connect started from a settings deep
 * link comes back to that same pane. It is signed because an unsigned state is an open
 * redirect wearing a seatbelt.
 */
process.env.HUBSPOT_CLIENT_ID = "test-client";
process.env.HUBSPOT_CLIENT_SECRET = "test-secret";
process.env.SALESFORCE_CLIENT_ID = "sf-cid";
process.env.SALESFORCE_CLIENT_SECRET = "sf-secret";
// Deterministic: force the module's dev-secret fallback so the "hand-signed with the real
// secret" checks below can reproduce it without reaching into the module's internals, and so
// this suite behaves the same regardless of what happens to be in the shell environment.
delete process.env.ENCRYPTION_SECRET;
if (process.env.NODE_ENV === "production") {
  (process.env as Record<string, string>).NODE_ENV = "test";
}

import { createHash, createHmac } from "crypto";
import {
  OAuthTokenError,
  buildAuthorizeUrl,
  exchangeCode,
  isTrustedInstanceUrl,
  parseOAuthState,
  pkceVerifierForState,
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

  // --- Salesforce: PKCE, sandbox variant, instance token host (Leads P5) ----------------
  {
    const url = new URL(buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["api", "refresh_token", "id"], returnTo: "/leads" }));
    check("production authorizes at login.salesforce.com", url.origin === "https://login.salesforce.com" && url.pathname === "/services/oauth2/authorize", url.href);
    const state = url.searchParams.get("state");
    const verifier = pkceVerifierForState(state);
    check("the state yields a verifier", typeof verifier === "string" && /^[A-Za-z0-9_-]{43}$/.test(verifier ?? ""), String(verifier));
    const challenge = createHash("sha256").update(verifier ?? "").digest("base64url");
    check("the challenge is S256 of that verifier", url.searchParams.get("code_challenge") === challenge && url.searchParams.get("code_challenge_method") === "S256");
    check("the verifier is stable for one state", pkceVerifierForState(state) === verifier);
    const other = new URL(buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["api"], returnTo: "/leads" })).searchParams.get("state");
    check("and differs between states", pkceVerifierForState(other) !== verifier);
    check("a tampered state yields none", pkceVerifierForState(`${state}x`) === null);
    check("the verifier never appears in the URL", !url.href.includes(verifier ?? "∅"));

    const sandbox = new URL(buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["api"], returnTo: "/leads", variant: "sandbox" }));
    check("a sandbox authorizes at test.salesforce.com", sandbox.origin === "https://test.salesforce.com", sandbox.href);
    check("the variant is signed into the state", parseOAuthState(sandbox.searchParams.get("state"))?.variant === "sandbox");
    check("an unknown variant is refused", (() => { try { buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "x", scopes: [], returnTo: "/", variant: "nope" }); return false; } catch { return true; } })());
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      check(`an inherited property name is not a variant ("${inherited}")`, (() => { try { buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "x", scopes: [], returnTo: "/", variant: inherited }); return false; } catch { return true; } })());
    }

    const hub = new URL(buildAuthorizeUrl("hubspot", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["a"], returnTo: "/leads" }));
    check("HubSpot sends no PKCE challenge", !hub.searchParams.has("code_challenge"));

    const seen: Array<{ url: string; body: string }> = [];
    const tokenStub = (json: object, status = 200): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const sfToken = { access_token: "at", refresh_token: "rt", instance_url: "https://acme.my.salesforce.com", id: "https://login.salesforce.com/id/00D1/0051", token_type: "Bearer", issued_at: "1790000000000", signature: "sig" };

    const tokens = await exchangeCode("salesforce", "code-1", "https://orbit.test/cb", { fetchImpl: tokenStub(sfToken), codeVerifier: verifier!, variant: "sandbox" });
    check("a sandbox exchange goes to test.salesforce.com", seen.at(-1)?.url === "https://test.salesforce.com/services/oauth2/token", seen.at(-1)?.url);
    check("and sends the verifier", new URLSearchParams(seen.at(-1)?.body).get("code_verifier") === verifier);
    check("no expires_in means no expiry", tokens.expiresAt === null);
    check("instance_url and id ride in extra", tokens.extra?.instance_url === "https://acme.my.salesforce.com" && tokens.extra?.id === sfToken.id);

    await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ access_token: "at2", instance_url: "https://acme.my.salesforce.com" }), instanceUrl: "https://acme.my.salesforce.com" });
    check("a refresh goes to the org's own host", seen.at(-1)?.url === "https://acme.my.salesforce.com/services/oauth2/token", seen.at(-1)?.url);
    await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ access_token: "at3" }) });
    check("without one it goes to login.salesforce.com", seen.at(-1)?.url === "https://login.salesforce.com/services/oauth2/token", seen.at(-1)?.url);
    const refused = await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ access_token: "x" }), instanceUrl: "https://evil.example" }).then(() => null, (e: unknown) => e);
    check("an untrusted instance host is never sent the refresh token", refused instanceof OAuthTokenError && refused.needsReauth && !seen.some((s) => s.url.startsWith("https://evil.example")));
    const bad = await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ error: "invalid_grant", error_description: "expired access/refresh token" }, 400), instanceUrl: "https://acme.my.salesforce.com" }).then(() => null, (e: unknown) => e);
    check("invalid_grant means reconnect", bad instanceof OAuthTokenError && bad.needsReauth);

    check("isTrustedInstanceUrl trusts a My Domain host", isTrustedInstanceUrl("salesforce", "https://acme.my.salesforce.com"));
    check("and refuses look-alikes", !isTrustedInstanceUrl("salesforce", "https://salesforce.com.evil.example") && !isTrustedInstanceUrl("salesforce", "http://acme.my.salesforce.com") && !isTrustedInstanceUrl("salesforce", "https://evilsalesforce.com"));
    check("a provider without instance hosts trusts none", !isTrustedInstanceUrl("hubspot", "https://api.hubapi.com"));
  }
}

exchange().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector OAuth checks passed.");
  process.exit(0);
});
