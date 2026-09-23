/**
 * `openConnectorAuth`: every provider call gets a token that is valid when it is sent.
 *
 * The rules are the ones the sync scheduler's error handling depends on — a refresh that the
 * provider refuses must end in `needs_reauth` (the person has to reconnect), while a provider
 * having a bad minute must NOT (the scheduler backs off and tries again).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import {
  claimConnectorConnectionForUser,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { OAuthTokenError, type OAuthTokens } from "../src/lib/connectors/oauth";
import {
  ConnectorAuthError,
  ConnectorNeedsReauthError,
  openConnectorAuth,
} from "../src/lib/connectors/token";
import { decryptOrNull } from "../src/lib/crypto";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-token";

async function fresh(opts: { expiresInMs: number | null; refreshToken?: string | null }) {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await upsertConnectorConnection({
    userId: USER,
    connectorId: "hubspot",
    authKind: "oauth2",
    accessToken: "access-old",
    refreshToken: opts.refreshToken === undefined ? "refresh-old" : opts.refreshToken,
    tokenExpiresAt: opts.expiresInMs === null ? null : new Date(Date.now() + opts.expiresInMs),
    nextSyncAt: null,
  });
  const conn = await claimConnectorConnectionForUser(USER, "hubspot");
  if (!conn) throw new Error("setup: could not claim");
  return conn;
}

async function row() {
  const db = await getDb();
  const [r] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  return r;
}

function refresher(result: OAuthTokens | Error) {
  const calls: string[] = [];
  const refresh = async (_id: string, refreshToken: string) => {
    calls.push(refreshToken);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, refresh };
}

const NEW_TOKENS: OAuthTokens = {
  accessToken: "access-new",
  refreshToken: null,
  expiresAt: new Date(Date.now() + 1_800_000),
  scopes: null,
};

run(async () => {
  console.log("a token with time left is used as stored");
  {
    const conn = await fresh({ expiresInMs: 3_600_000 });
    const r = refresher(NEW_TOKENS);
    const seen: string[] = [];
    await openConnectorAuth(conn, { refresh: r.refresh }).call(async (t) => seen.push(t));
    check("the stored token is sent", seen[0] === "access-old", seen.join(","));
    check("and nothing is refreshed", r.calls.length === 0);
  }

  console.log("\na token about to lapse is refreshed first (proactive)");
  {
    const conn = await fresh({ expiresInMs: 30_000 });
    const r = refresher(NEW_TOKENS);
    const seen: string[] = [];
    await openConnectorAuth(conn, { refresh: r.refresh }).call(async (t) => seen.push(t));
    check("the refresh ran once, with the stored refresh token", r.calls.join(",") === "refresh-old");
    check("the call got the new token", seen[0] === "access-new");
    const stored = await row();
    check("the new token is stored", decryptOrNull(stored?.accessTokenEncrypted ?? null) === "access-new");
    check("the refresh token is kept when none comes back", decryptOrNull(stored?.refreshTokenEncrypted ?? null) === "refresh-old");
  }

  console.log("\na 401 refreshes once and retries the call (reactive)");
  {
    const conn = await fresh({ expiresInMs: 3_600_000 });
    const r = refresher({ ...NEW_TOKENS, refreshToken: "refresh-rotated" });
    const seen: string[] = [];
    const auth = openConnectorAuth(conn, { refresh: r.refresh });
    const out = await auth.call(async (t) => {
      seen.push(t);
      if (t === "access-old") throw new ConnectorAuthError("401");
      return "ok";
    });
    check("the retry succeeded", out === "ok");
    check("it was sent with the old token, then the new", seen.join(",") === "access-old,access-new");
    check("a rotated refresh token is kept in memory", conn.refreshToken === "refresh-rotated");
    check("and stored", decryptOrNull((await row())?.refreshTokenEncrypted ?? null) === "refresh-rotated");

    console.log("\n…but only once per run");
    let second: unknown = null;
    try {
      await auth.call(async () => {
        throw new ConnectorAuthError("401 again");
      });
    } catch (err) {
      second = err;
    }
    check("a second 401 in the same run means reconnect", second instanceof ConnectorNeedsReauthError, String(second));
    check("no second refresh was attempted", r.calls.length === 1, String(r.calls.length));
    check("the row is marked needs_reauth", (await row())?.status === "needs_reauth");
  }

  console.log("\na refused refresh means reconnect");
  {
    const conn = await fresh({ expiresInMs: 30_000 });
    const r = refresher(new OAuthTokenError("BAD_REFRESH_TOKEN", true));
    let caught: unknown = null;
    try {
      await openConnectorAuth(conn, { refresh: r.refresh }).call(async () => "never");
    } catch (err) {
      caught = err;
    }
    check("it throws ConnectorNeedsReauthError", caught instanceof ConnectorNeedsReauthError, String(caught));
    const stored = await row();
    check("the row needs reauth", stored?.status === "needs_reauth");
    check("and is disarmed", stored?.nextSyncAt === null);
  }

  console.log("\na provider having a bad minute does NOT mean reconnect");
  {
    const conn = await fresh({ expiresInMs: 30_000 });
    const r = refresher(new OAuthTokenError("Token endpoint returned 503", false));
    let caught: unknown = null;
    try {
      await openConnectorAuth(conn, { refresh: r.refresh }).call(async () => "never");
    } catch (err) {
      caught = err;
    }
    check("the provider's error propagates as-is", caught instanceof OAuthTokenError && !(caught instanceof ConnectorNeedsReauthError));
    check("the row stays active", (await row())?.status === "active");
  }

  console.log("\nno refresh token and an expired access token means reconnect");
  {
    const conn = await fresh({ expiresInMs: -1000, refreshToken: null });
    const r = refresher(NEW_TOKENS);
    let caught: unknown = null;
    try {
      await openConnectorAuth(conn, { refresh: r.refresh }).call(async () => "never");
    } catch (err) {
      caught = err;
    }
    check("it throws ConnectorNeedsReauthError", caught instanceof ConnectorNeedsReauthError);
    check("without trying to refresh", r.calls.length === 0);
  }

  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector token checks passed.");
});
