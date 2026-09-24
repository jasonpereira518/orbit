/**
 * Google grant revocation: the exact request, every outcome mapped, never a throw, and the
 * connections purge step revoking before the token is gone. Run: npx tsx scripts/smoke-oauth-revoke.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_REVOKE_URL, revokeGoogleGrant, revokeGoogleToken } from "../src/lib/oauth-revoke";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-oauth-revoke-user";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Call = { url: string; body: string; method: string };
function fakeFetch(status: number, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), method: String(init?.method) });
    return new Response(null, { status });
  }) as typeof fetch;
}

async function main() {
  console.log("revokeGoogleToken");
  const calls: Call[] = [];
  check("200 → revoked", (await revokeGoogleToken("tok-1", { fetchImpl: fakeFetch(200, calls) })) === "revoked");
  check("...as a form POST to Google's revoke endpoint", calls[0]?.url === GOOGLE_REVOKE_URL && calls[0]?.method === "POST" && calls[0]?.body === "token=tok-1", JSON.stringify(calls[0]));
  check("400 → already_invalid", (await revokeGoogleToken("tok", { fetchImpl: fakeFetch(400, []) })) === "already_invalid");
  check("500 → error", (await revokeGoogleToken("tok", { fetchImpl: fakeFetch(500, []) })) === "error");
  check("no token → skipped, no request", (await revokeGoogleToken(null, { fetchImpl: fakeFetch(200, calls) })) === "skipped" && calls.length === 1);
  const throwing = (async () => { throw new Error("network down"); }) as typeof fetch;
  check("a network error → error, not a throw", (await revokeGoogleToken("tok", { fetchImpl: throwing })) === "error");
  const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const started = Date.now();
  check("a hung request times out → error", (await revokeGoogleToken("tok", { fetchImpl: hanging, timeoutMs: 50 })) === "error" && Date.now() - started < 2000);

  console.log("\nrevokeGoogleGrant");
  const grantCalls: Call[] = [];
  await revokeGoogleGrant({ refreshTokenEncrypted: encrypt("refresh-plain"), accessTokenEncrypted: encrypt("access-plain") }, { fetchImpl: fakeFetch(200, grantCalls) });
  check("prefers the refresh token (revoking it ends the whole grant)", grantCalls[0]?.body === "token=refresh-plain");
  await revokeGoogleGrant({ refreshTokenEncrypted: null, accessTokenEncrypted: encrypt("access-plain") }, { fetchImpl: fakeFetch(200, grantCalls) });
  check("falls back to the access token", grantCalls[1]?.body === "token=access-plain");
  check("an undecryptable token is skipped", (await revokeGoogleGrant({ refreshTokenEncrypted: "garbage", accessTokenEncrypted: "garbage" }, { fetchImpl: fakeFetch(200, grantCalls) })) === "skipped");

  console.log("\nThe connections purge step");
  const db = await getDb();
  await db.insert(schema.gmailConnections).values({
    userId: USER,
    emailAddress: "revoke@example.test",
    accessTokenEncrypted: encrypt("purge-access"),
    refreshTokenEncrypted: encrypt("purge-refresh"),
  });
  const realFetch = globalThis.fetch;
  const purgeCalls: Call[] = [];
  globalThis.fetch = fakeFetch(200, purgeCalls);
  try {
    await purgeUserData(USER, { only: ["connections"] });
  } finally {
    globalThis.fetch = realFetch;
  }
  check("purging connections revokes the Google grant", purgeCalls.some((c) => c.url === GOOGLE_REVOKE_URL && c.body === "token=purge-refresh"), JSON.stringify(purgeCalls));
  check("...and the row is gone", (await db.query.gmailConnections.findMany()).every((r) => r.userId !== USER));
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  console.log("\nAll revoke checks passed.");
}

run(main);
