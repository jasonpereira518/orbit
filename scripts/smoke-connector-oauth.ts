/**
 * The generic OAuth2 helper. Pure: every network call is injected.
 *
 * The state parameter carries the return path, so a connect started from a settings deep
 * link comes back to that same pane. It is signed because an unsigned state is an open
 * redirect wearing a seatbelt.
 */
process.env.HUBSPOT_CLIENT_ID = "test-client";
process.env.HUBSPOT_CLIENT_SECRET = "test-secret";

import { createHmac } from "crypto";
import {
  OAuthTokenError,
  buildAuthorizeUrl,
  exchangeCode,
  parseOAuthState,
  signOAuthState,
} from "../src/lib/connectors/oauth";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
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
const forged = signOAuthState({ userId: "u1", connectorId: "hubspot", returnTo: "https://evil.example" });
check("an absolute return path is refused", parseOAuthState(forged)?.returnTo === "/settings");

// A state signed with a different secret must be rejected outright, not just have its
// returnTo sanitized — otherwise a forged state with a fabricated userId/connectorId would
// pass verification as long as its returnTo happened to look safe.
const foreignMac = createForeignSignedState({ userId: "attacker", connectorId: "hubspot", returnTo: "/settings" });
check("a state signed with a different secret is rejected", parseOAuthState(foreignMac) === null);

// Protocol-relative return paths are an open-redirect vector too (`//evil.example` is
// browser-parsed as `https://evil.example`), and must be refused the same as an absolute URL.
const protocolRelative = signOAuthState({
  userId: "u1",
  connectorId: "hubspot",
  returnTo: "//evil.example",
});
check(
  "a protocol-relative return path is refused",
  parseOAuthState(protocolRelative)?.returnTo === "/settings"
);

function createForeignSignedState(state: {
  userId: string;
  connectorId: string;
  returnTo: string;
}): string {
  // Sign with a secret the real module does not know, to prove parseOAuthState actually
  // verifies the HMAC rather than trusting whatever payload shows up.
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const mac = createHmac("sha256", "a-different-secret-entirely").update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

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
}

exchange().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector OAuth checks passed.");
  process.exit(0);
});
