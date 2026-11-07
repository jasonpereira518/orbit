/**
 * Contract tests for the Google and Microsoft OAuth token endpoints as `gmail.ts` and
 * `outlook.ts` speak to them: the code-for-token exchange the callback routes run, and the
 * refresh `getValidAccessToken` runs on every sync.
 *
 * Both paths end in `return res.json()` with no check that an `access_token` came back, so
 * this pins what happens when the endpoint answers in a way the happy path never sees:
 *
 *   - a 200 whose JSON has no `access_token` (a misconfigured proxy, a provider incident),
 *   - a 200 that is not JSON at all,
 *   - `400 invalid_grant` (a dead grant, which must become a reconnect),
 *   - a 503 HTML page and a network failure (transient, which must NOT).
 *
 * What makes these safe today, and is therefore what the checks pin: in the callback, the
 * very next step spends the token on a profile read, which fails loudly on "Bearer undefined"
 * before anything is stored; on refresh, `encrypt(undefined)` throws before the UPDATE, so the
 * stored row is untouched and stays `active` (a transient fault must never flag every account
 * as needing a reconnect). Neither path stores a broken connection — verified against PGlite.
 * The error a malformed 200 produces is a raw `TypeError`/`SyntaxError`, not Orbit's own
 * words; every caller seen (callback route, sync scheduler, actions via `friendlyError`) maps
 * it to generic copy, so it is pinned as "rejects, not a reconnect" rather than by message.
 *
 * Token endpoints are mocked; nothing leaves the machine. Fake client ids and secrets only.
 *
 * Run: npx tsx scripts/smoke-contract-oauth-tokens.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.GOOGLE_CLIENT_ID = "test-google-client-not-real";
process.env.GOOGLE_CLIENT_SECRET = "test-secret-not-real";
process.env.GOOGLE_REDIRECT_URI = "https://orbit.example.com/api/gmail/callback";
process.env.MICROSOFT_CLIENT_ID = "test-ms-client-not-real";
process.env.MICROSOFT_CLIENT_SECRET = "test-secret-not-real";
process.env.MICROSOFT_REDIRECT_URI = "https://orbit.example.com/api/outlook/callback";
delete process.env.MICROSOFT_TENANT_ID;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, outlookConnections } from "../src/db/schema";
import { decrypt, encrypt } from "../src/lib/crypto";
import { ReauthRequiredError } from "../src/lib/errors";
import * as gmail from "../src/lib/gmail";
import * as outlook from "../src/lib/outlook";
import { checker } from "./smoke/check";
import { fakeUserId, makeContact, purgeUsers } from "./smoke/factories";
import { json, mockFetch, networkError, notJson, route, status, type Call } from "./smoke/http-mock";

const t = checker();
const G_USER = fakeUserId("oauth_g");
const M_USER = fakeUserId("oauth_m");
const MINUTE = 60_000;
const ADA = makeContact(0);

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const GOOD_GOOGLE = {
  access_token: "ya29.test-access-not-real",
  expires_in: 3599,
  refresh_token: "1//test-refresh-not-real",
  scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly",
  token_type: "Bearer",
  id_token: "eyJ.test.not-real",
};
const GOOD_MS = {
  token_type: "Bearer",
  scope: "openid profile email offline_access https://graph.microsoft.com/Calendars.Read",
  expires_in: 4473,
  ext_expires_in: 4473,
  access_token: "EwB4A8l6.test-access-not-real",
  refresh_token: "M.C123.test-refresh-not-real",
};
/** What both endpoints answer for a revoked/expired refresh token. */
const GOOGLE_INVALID_GRANT = { error: "invalid_grant", error_description: "Token has been expired or revoked." };
const MS_INVALID_GRANT = {
  error: "invalid_grant",
  error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
  error_codes: [700082],
  timestamp: "2026-10-17 00:00:00Z",
  trace_id: "00000000-0000-0000-0000-000000000000",
  correlation_id: "00000000-0000-0000-0000-000000000000",
};

type Provider = {
  name: "Google" | "Microsoft";
  tokenUrl: string;
  good: Record<string, unknown>;
  invalidGrant: Record<string, unknown>;
  exchange: (code: string) => Promise<{ access_token: string }>;
  profileRoute: RegExp;
  profileBody: Record<string, unknown>;
  profile: (token: string) => Promise<string>;
  getToken: (userId: string) => Promise<string>;
  userId: string;
  seed: () => Promise<void>;
  row: () => Promise<{ status: string; accessTokenEncrypted: string; tokenExpiresAt: Date | null; nextSyncAt: Date | null }>;
};

const PROVIDERS: Provider[] = [
  {
    name: "Google",
    tokenUrl: GOOGLE_TOKEN_URL,
    good: GOOD_GOOGLE,
    invalidGrant: GOOGLE_INVALID_GRANT,
    exchange: gmail.exchangeCodeForTokens,
    profileRoute: /googleapis\.com\/oauth2\/v2\/userinfo/,
    profileBody: { id: "1234567890", email: ADA.email, verified_email: true, picture: "https://lh3.googleusercontent.com/a/x" },
    profile: gmail.fetchGoogleProfileEmail,
    getToken: (u) => gmail.getValidAccessToken(u),
    userId: G_USER,
    seed: async () => {
      const db = await getDb();
      await db.delete(gmailConnections).where(eq(gmailConnections.userId, G_USER));
      await db.insert(gmailConnections).values({
        userId: G_USER,
        emailAddress: ADA.email,
        accessTokenEncrypted: encrypt("stale-google-access"),
        refreshTokenEncrypted: encrypt("1//stored-refresh-not-real"),
        tokenExpiresAt: new Date(Date.now() - MINUTE),
        status: "active",
        nextSyncAt: new Date(Date.now() + 30 * MINUTE),
      });
    },
    row: async () => (await (await getDb()).query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, G_USER) }))!,
  },
  {
    name: "Microsoft",
    tokenUrl: MS_TOKEN_URL,
    good: GOOD_MS,
    invalidGrant: MS_INVALID_GRANT,
    exchange: outlook.exchangeCodeForTokens,
    profileRoute: /graph\.microsoft\.com\/v1\.0\/me$/,
    profileBody: { id: "a1b2", displayName: ADA.fullName, mail: ADA.email, userPrincipalName: ADA.email },
    profile: outlook.fetchMicrosoftProfileEmail,
    getToken: (u) => outlook.getValidAccessToken(u),
    userId: M_USER,
    seed: async () => {
      const db = await getDb();
      await db.delete(outlookConnections).where(eq(outlookConnections.userId, M_USER));
      await db.insert(outlookConnections).values({
        userId: M_USER,
        emailAddress: ADA.email,
        accessTokenEncrypted: encrypt("stale-ms-access"),
        refreshTokenEncrypted: encrypt("M.stored-refresh-not-real"),
        tokenExpiresAt: new Date(Date.now() - MINUTE),
        status: "active",
        nextSyncAt: new Date(Date.now() + 30 * MINUTE),
      });
    },
    row: async () => (await (await getDb()).query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, M_USER) }))!,
  },
];

/** The profile endpoint refuses anything but the real token — as the providers do. */
function profileHandler(p: Provider) {
  return (call: Call) =>
    call.headers.authorization === `Bearer ${p.good.access_token}`
      ? json(p.profileBody)
      : status(401, { error: { code: 401, message: "Invalid Credentials" } });
}

async function outcome<T>(fn: () => Promise<T>): Promise<{ value: T | null; err: unknown }> {
  try {
    return { value: await fn(), err: null };
  } catch (err) {
    return { value: null, err };
  }
}

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [G_USER, M_USER]);

  for (const p of PROVIDERS) {
    console.log(`\n${p.name}: code exchange`);
    {
      const http = mockFetch([route("POST", p.tokenUrl, () => json(p.good))]);
      try {
        const tokens = await p.exchange("4/0AQ-test-code-not-real");
        const body = new URLSearchParams(http.calls[0].body ?? "");
        t.check("a good answer is returned as-is", tokens.access_token === p.good.access_token);
        t.check(
          "the form carries code, grant type, client and redirect",
          body.get("code") === "4/0AQ-test-code-not-real" &&
            body.get("grant_type") === "authorization_code" &&
            body.get("client_secret") === "test-secret-not-real" &&
            (body.get("redirect_uri") ?? "").endsWith("/callback")
        );
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", p.tokenUrl, () => status(400, p.invalidGrant))]);
      try {
        await t.rejects("400 invalid_grant rejects as a failed exchange", () => p.exchange("used-code"), (e) =>
          e instanceof Error && e.message.startsWith("Token exchange failed")
        );
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", p.tokenUrl, networkError)]);
      try {
        await t.rejects("a network failure rejects", () => p.exchange("code"));
      } finally {
        http.restore();
      }
    }
    {
      const http = mockFetch([route("POST", p.tokenUrl, () => notJson("<html><body>502 Bad Gateway</body></html>"))]);
      try {
        await t.rejects("a non-JSON 200 rejects (the callback maps any rejection to oauth_failed)", () => p.exchange("code"));
      } finally {
        http.restore();
      }
    }
    {
      // The callback's own next two steps: exchange, then spend the token on the profile read.
      const noToken = { token_type: "Bearer", expires_in: 3599, scope: "openid" };
      const http = mockFetch([
        route("POST", p.tokenUrl, () => json(noToken)),
        route("GET", p.profileRoute, profileHandler(p)),
      ]);
      try {
        const exchanged = await outcome(() => p.exchange("code"));
        t.check("a 200 without access_token is returned without complaint (no check in exchange)", exchanged.err === null && exchanged.value?.access_token === undefined);
        const prof = await outcome(() => p.profile(String(exchanged.value?.access_token)));
        t.check(
          "…but the callback's profile read then fails loudly before anything is stored",
          prof.err instanceof Error && /profile/i.test(prof.err.message),
          String(prof.err)
        );
        t.check("…and what reached the profile endpoint was 'Bearer undefined', not a real token", http.calls[1]?.headers.authorization === "Bearer undefined");
      } finally {
        http.restore();
      }
    }

    console.log(`${p.name}: refresh via getValidAccessToken`);
    {
      await p.seed();
      const http = mockFetch([route("POST", p.tokenUrl, () => json(p.good))]);
      try {
        const token = await p.getToken(p.userId);
        const row = await p.row();
        t.check("a good refresh returns and stores the new token", token === p.good.access_token && decrypt(row.accessTokenEncrypted) === p.good.access_token);
        t.check("the refresh form uses grant_type=refresh_token", new URLSearchParams(http.calls[0].body ?? "").get("grant_type") === "refresh_token");
      } finally {
        http.restore();
      }
    }
    {
      await p.seed();
      const http = mockFetch([route("POST", p.tokenUrl, () => status(400, p.invalidGrant))]);
      try {
        const r = await outcome(() => p.getToken(p.userId));
        const row = await p.row();
        t.check("400 invalid_grant becomes ReauthRequiredError", r.err instanceof ReauthRequiredError, String(r.err));
        t.check("…and parks the row: needs_reauth, unscheduled", row.status === "needs_reauth" && row.nextSyncAt === null, `${row.status} ${String(row.nextSyncAt)}`);
      } finally {
        http.restore();
      }
    }

    const transient: Array<[string, () => Response | never]> = [
      ["a 200 with no access_token", () => json({ token_type: "Bearer", expires_in: 3599 })],
      ["a non-JSON 200", () => notJson()],
      ["a 503 HTML page", () => status(503, "<html><body>Service Unavailable</body></html>")],
      ["a 500 JSON error", () => status(500, { error: "server_error", error_description: "backend unavailable" })],
    ];
    for (const [label, reply] of transient) {
      await p.seed();
      const before = await p.row();
      const http = mockFetch([route("POST", p.tokenUrl, reply)]);
      try {
        const r = await outcome(() => p.getToken(p.userId));
        const row = await p.row();
        t.check(`${label}: rejects, and never returns an undefined token`, r.err instanceof Error && r.value === null, `value=${String(r.value)}`);
        t.check(`${label}: is not a reconnect (transient)`, !(r.err instanceof ReauthRequiredError), String(r.err));
        t.check(
          `${label}: the stored row is untouched and stays active`,
          row.status === "active" && row.accessTokenEncrypted === before.accessTokenEncrypted && row.nextSyncAt?.getTime() === before.nextSyncAt?.getTime(),
          row.status
        );
      } finally {
        http.restore();
      }
    }
    {
      await p.seed();
      const http = mockFetch([route("POST", p.tokenUrl, networkError)]);
      try {
        const r = await outcome(() => p.getToken(p.userId));
        const row = await p.row();
        t.check("a network failure rejects as transient and leaves the row active", r.err instanceof Error && !(r.err instanceof ReauthRequiredError) && row.status === "active");
      } finally {
        http.restore();
      }
    }
  }

  console.log("\nupsert with a token-less grant writes nothing");
  {
    const db2 = await getDb();
    await db2.delete(gmailConnections).where(eq(gmailConnections.userId, G_USER));
    const r = await outcome(() => gmail.upsertGmailConnection(G_USER, { token_type: "Bearer" } as unknown as gmail.TokenResponse, ADA.email));
    const row = await db2.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, G_USER) });
    t.check("encrypt(undefined) throws before the INSERT, so no broken connection row exists", r.err instanceof Error && !row, String(r.err));
  }

  await purgeUsers(db, [G_USER, M_USER]);
  t.done("oauth tokens contract");
});
