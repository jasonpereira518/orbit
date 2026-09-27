/**
 * What a token refresh may and may not touch.
 *
 * A refresh is not a reconnect. Only the OAuth callback may re-arm calendar sync; a refresh
 * that resets `next_sync_at`/`sync_failures`/`sync_error` makes backoff never converge and
 * re-arms rows the scheduler disarmed. And a dead grant must reach the scheduler as a
 * `ReauthRequiredError`, or the scheduler re-arms the row `markNeedsReauth` just parked.
 *
 * The token endpoints are stubbed on `globalThis.fetch`; nothing leaves the machine.
 *
 * Run: npx tsx scripts/smoke-token-refresh.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

// Read lazily inside refreshAccessToken, so setting them here lands before any read.
process.env.GOOGLE_CLIENT_ID = "smoke-google-client";
process.env.GOOGLE_CLIENT_SECRET = "smoke-google-secret";
process.env.MICROSOFT_CLIENT_ID = "smoke-ms-client";
process.env.MICROSOFT_CLIENT_SECRET = "smoke-ms-secret";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, outlookConnections } from "../src/db/schema";
import { decrypt, encrypt } from "../src/lib/crypto";
import { ReauthRequiredError } from "../src/lib/errors";
import { getValidAccessToken } from "../src/lib/gmail";
import { getValidAccessToken as getValidOutlookAccessToken } from "../src/lib/outlook";
import { runSyncPass } from "../src/lib/sync-scheduler";

const G_USER = "refresh-gmail-user";
const O_USER = "refresh-outlook-user";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const MINUTE = 60_000;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const realFetch = globalThis.fetch;
let tokenCalls = 0;
let tokenReply: () => Response = () =>
  Response.json({ access_token: "fresh-access", expires_in: 3600 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://oauth2.googleapis.com/token") || url.includes("login.microsoftonline.com")) {
    tokenCalls++;
    return tokenReply();
  }
  return realFetch(input, init);
}) as typeof fetch;

async function seedGmail(over: Partial<typeof gmailConnections.$inferInsert> = {}) {
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, G_USER));
  await db.insert(gmailConnections).values({
    userId: G_USER,
    emailAddress: "refresh@example.com",
    accessTokenEncrypted: encrypt("stale-access"),
    refreshTokenEncrypted: encrypt("refresh-1"),
    tokenExpiresAt: new Date(Date.now() - MINUTE),
    scopes: CALENDAR_SCOPE,
    status: "active",
    nextSyncAt: null,
    syncStatus: "error",
    syncFailures: 3,
    syncError: "Google Calendar 503: upstream",
    ...over,
  });
}

async function gmailRow() {
  const db = await getDb();
  return (await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, G_USER) }))!;
}

run(async () => {
  console.log("a refresh stores the token and leaves sync state alone");
  await seedGmail();
  tokenCalls = 0;
  tokenReply = () => Response.json({ access_token: "fresh-access", expires_in: 3600 });
  const token = await getValidAccessToken(G_USER);
  let row = await gmailRow();
  check("returns the refreshed token", token === "fresh-access", token);
  check("stores the refreshed token", decrypt(row.accessTokenEncrypted) === "fresh-access");
  check("stores the new expiry", (row.tokenExpiresAt?.getTime() ?? 0) > Date.now() + 50 * MINUTE);
  check("keeps the refresh token when none is rotated", decrypt(row.refreshTokenEncrypted!) === "refresh-1");
  check("does NOT re-arm a disarmed sync", row.nextSyncAt === null, String(row.nextSyncAt));
  check("does NOT reset the failure counter", row.syncFailures === 3, String(row.syncFailures));
  check("does NOT clear the sync error", row.syncError === "Google Calendar 503: upstream", String(row.syncError));

  console.log("a rotated refresh token is kept");
  await seedGmail();
  tokenReply = () => Response.json({ access_token: "fresh-2", refresh_token: "refresh-2", expires_in: 3600 });
  await getValidAccessToken(G_USER);
  row = await gmailRow();
  check("stores the rotated refresh token", decrypt(row.refreshTokenEncrypted!) === "refresh-2");

  console.log("a caller can ask for a token that outlives its own budget");
  await seedGmail({ tokenExpiresAt: new Date(Date.now() + 3 * MINUTE), accessTokenEncrypted: encrypt("three-minutes-left") });
  tokenCalls = 0;
  tokenReply = () => Response.json({ access_token: "long-lived", expires_in: 3600 });
  const plain = await getValidAccessToken(G_USER);
  check("the default window reuses a token with three minutes left", plain === "three-minutes-left" && tokenCalls === 0, `${plain} after ${tokenCalls} refreshes`);
  const long = await getValidAccessToken(G_USER, { minValidityMs: 5 * MINUTE });
  check("asking for five minutes refreshes it", long === "long-lived" && tokenCalls === 1, `${long} after ${tokenCalls} refreshes`);

  console.log("a dead grant surfaces as ReauthRequiredError");
  await seedGmail();
  tokenReply = () => new Response('{"error":"invalid_grant"}', { status: 400 });
  let thrown: unknown = null;
  try {
    await getValidAccessToken(G_USER);
  } catch (err) {
    thrown = err;
  }
  check("rejects with ReauthRequiredError", thrown instanceof ReauthRequiredError, String(thrown));
  check("…with the reconnect message", (thrown as Error | null)?.message === "Gmail session expired — reconnect");
  row = await gmailRow();
  check("marks the row needs_reauth", row.status === "needs_reauth", row.status);

  console.log("the scheduler keeps a dead grant disarmed");
  {
    const db = await getDb();
    await db.execute(sql`UPDATE gmail_connections SET next_sync_at = NULL WHERE user_id <> ${G_USER}`);
    await seedGmail({ nextSyncAt: new Date(Date.now() - MINUTE), syncFailures: 0, syncError: null, syncStatus: "idle" });
    tokenReply = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    await runSyncPass({
      deps: {
        getAccessToken: getValidAccessToken,
        fetchPage: async () => {
          throw new Error("must not fetch a calendar with a dead grant");
        },
      },
    });
    row = await gmailRow();
    check("status is needs_reauth", row.status === "needs_reauth", row.status);
    check("next_sync_at stays NULL (not re-armed by a retryable failure)", row.nextSyncAt === null, String(row.nextSyncAt));
    check("the failure did not walk the backoff ladder", row.syncFailures === 0, String(row.syncFailures));
  }

  console.log("Outlook: same split, and interaction_required is a dead grant");
  {
    const db = await getDb();
    const seedOutlook = async () => {
      await db.delete(outlookConnections).where(eq(outlookConnections.userId, O_USER));
      await db.insert(outlookConnections).values({
        userId: O_USER,
        emailAddress: "refresh@outlook.test",
        accessTokenEncrypted: encrypt("stale-ms"),
        refreshTokenEncrypted: encrypt("ms-refresh"),
        tokenExpiresAt: new Date(Date.now() - MINUTE),
        status: "active",
        nextSyncAt: null,
        syncFailures: 2,
        syncError: "earlier failure",
      });
    };
    await seedOutlook();
    tokenReply = () => Response.json({ access_token: "fresh-ms", expires_in: 3600 });
    const msToken = await getValidOutlookAccessToken(O_USER);
    const ms = (await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, O_USER) }))!;
    check("returns the refreshed token", msToken === "fresh-ms");
    check("does NOT re-arm or reset sync state", ms.nextSyncAt === null && ms.syncFailures === 2 && ms.syncError === "earlier failure");

    await seedOutlook();
    tokenReply = () => new Response('{"error":"interaction_required","error_description":"AADSTS50076"}', { status: 400 });
    let msThrown: unknown = null;
    try {
      await getValidOutlookAccessToken(O_USER);
    } catch (err) {
      msThrown = err;
    }
    const after = (await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, O_USER) }))!;
    check("interaction_required rejects with ReauthRequiredError", msThrown instanceof ReauthRequiredError, String(msThrown));
    check("…and marks the row needs_reauth", after.status === "needs_reauth", after.status);
    await db.delete(outlookConnections).where(eq(outlookConnections.userId, O_USER));
  }

  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, G_USER));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll token-refresh checks passed.");
});
