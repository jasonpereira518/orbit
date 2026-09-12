/**
 * The grant that lets a signed-out phone contribute one scan.
 *
 * WHAT THIS GUARDS. This is a public, token-authenticated write path — the only one in the
 * app that accepts user content without a Clerk session — so the interesting cases are all
 * the ways it must refuse. A malformed token must cost zero queries, an expired one must be
 * indistinguishable from a nonexistent one, a suspended account must go quiet, a transcript
 * must be readable exactly once, and a token must never drain an account other than the one
 * that minted it. Each of those is a silent failure if it regresses: the happy path keeps
 * working and only the refusals stop.
 *
 * It also pins the promise that no photograph is ever stored. The table holds text.
 *
 * Runs against a throwaway PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-scan-handoff.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { captureHandoffs, userSettings } from "../src/db/schema";
import {
  HANDOFF_TTL_MS,
  buildScanHandoffUrl,
  cancelScanHandoff,
  claimScanHandoff,
  findScanHandoff,
  generateHandoffToken,
  hashHandoffToken,
  looksLikeHandoffToken,
  markHandoffUploading,
  mintScanHandoff,
  recordHandoffError,
  recordHandoffTranscript,
  sweepExpiredHandoffs,
} from "../src/lib/scan-handoff";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-scan-handoff-user";
const OTHER = "smoke-scan-handoff-intruder";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await ensureUserSettings(OTHER);
  await db.delete(captureHandoffs);

  console.log("Token shape is checked before any query...");
  const { token } = generateHandoffToken();
  check("a minted token matches the shape", looksLikeHandoffToken(token), token);
  check("shape is orb_scan_<8 hex>_<43 base64url>", /^orb_scan_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/.test(token));
  check("garbage is rejected", !looksLikeHandoffToken("hello"));
  check("an empty token is rejected", !looksLikeHandoffToken(""));
  check("null is rejected", !looksLikeHandoffToken(null));
  check("an API key is not a handoff token", !looksLikeHandoffToken("orb_live_7f3a9c2b_" + "a".repeat(43)));
  check("two tokens never collide", generateHandoffToken().token !== generateHandoffToken().token);
  check("hashing is deterministic", hashHandoffToken(token) === hashHandoffToken(token));
  check("the hash is not the token", hashHandoffToken(token) !== token);

  console.log("\nMinting...");
  const minted = await mintScanHandoff(USER);
  check("returns a usable token", looksLikeHandoffToken(minted.token));
  check("the URL points at the phone page", minted.url === buildScanHandoffUrl(minted.token), minted.url);
  check("the URL embeds the token", minted.url.endsWith(minted.token));
  const ttl = minted.expiresAt.getTime() - Date.now();
  check("it expires within the advertised window", ttl > 0 && ttl <= HANDOFF_TTL_MS, `${ttl}ms`);

  const stored = await db.query.captureHandoffs.findFirst({
    where: eq(captureHandoffs.userId, USER),
  });
  check("a row exists", Boolean(stored));
  // The whole point of hashing: a database dump must not yield working grants.
  check("the raw token is NOT stored", stored!.tokenHash !== minted.token);
  check("the stored hash matches the token", stored!.tokenHash === hashHandoffToken(minted.token));
  check("it starts pending", stored!.status === "pending");
  check("no transcript yet", stored!.transcript === null);

  console.log("\nResolving a token to its grant...");
  const found = await findScanHandoff(minted.token);
  check("a live token resolves", found?.userId === USER);
  check("a well-formed but unknown token does not", (await findScanHandoff(generateHandoffToken().token)) === null);
  check("a malformed token does not", (await findScanHandoff("nope")) === null);

  console.log("\nThe phone uploads...");
  await markHandoffUploading(found!.id);
  const uploading = await claimScanHandoff(USER, minted.token);
  check("the desktop sees 'uploading' before any text", uploading.state === "uploading", uploading.state);

  await recordHandoffTranscript(found!.id, {
    transcript: "Ada Lovelace — Analytical Engines. Follow up next week.",
    pageCount: 2,
    sources: "photos:2",
  });

  console.log("\nOnly the minting account can claim...");
  const intruder = await claimScanHandoff(OTHER, minted.token);
  check("another signed-in account cannot drain the grant", intruder.state === "expired", intruder.state);
  const stillThere = await db.query.captureHandoffs.findFirst({
    where: eq(captureHandoffs.userId, USER),
  });
  check("...and the failed claim did not consume it", Boolean(stillThere));

  console.log("\nClaiming is single-use...");
  const claimed = await claimScanHandoff(USER, minted.token);
  check("the transcript comes back", claimed.state === "ready");
  if (claimed.state !== "ready") throw new Error("unreachable");
  check("with its text", claimed.transcript.includes("Ada Lovelace"));
  check("its page count", claimed.pageCount === 2);
  check("and its partial-success label", claimed.sources === "photos:2");

  const afterClaim = await db.query.captureHandoffs.findFirst({
    where: eq(captureHandoffs.userId, USER),
  });
  // The transcript must not outlive the handoff that carried it.
  check("the row is deleted on pickup", !afterClaim);
  const replay = await claimScanHandoff(USER, minted.token);
  check("a replayed claim gets nothing", replay.state === "expired", replay.state);

  console.log("\nA failed page is reported without burning the grant...");
  const retry = await mintScanHandoff(USER);
  const retryRow = await findScanHandoff(retry.token);
  await recordHandoffError(retryRow!.id, "That photo could not be read.");
  const errored = await claimScanHandoff(USER, retry.token);
  check("the desktop is told why", errored.state === "error", errored.state);
  if (errored.state === "error") {
    check("with the message", errored.message.includes("could not be read"));
  }
  // Walking back to the laptop for a fresh QR code just to retake one photo is a bad trade.
  check("the token still resolves, so the phone can retry", Boolean(await findScanHandoff(retry.token)));

  console.log("\nExpiry is indistinguishable from 'never existed'...");
  const expiring = await mintScanHandoff(USER);
  await db
    .update(captureHandoffs)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(captureHandoffs.tokenHash, hashHandoffToken(expiring.token)));
  check("an expired token does not resolve", (await findScanHandoff(expiring.token)) === null);
  check("and cannot be claimed", (await claimScanHandoff(USER, expiring.token)).state === "expired");

  console.log("\nExpired grants are swept...");
  await sweepExpiredHandoffs();
  const leftovers = await db.query.captureHandoffs.findMany();
  check("nothing expired is left behind", leftovers.every((r) => r.expiresAt.getTime() > Date.now()),
    `${leftovers.length} row(s) remain`);

  console.log("\nA suspended account goes quiet...");
  const suspended = await mintScanHandoff(USER);
  await db.update(userSettings).set({ suspendedAt: new Date() }).where(eq(userSettings.userId, USER));
  // requireUserId() never runs on this path, so its suspension gate does not cover it.
  check("its token stops resolving", (await findScanHandoff(suspended.token)) === null);
  await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, USER));
  check("and resumes when unsuspended", Boolean(await findScanHandoff(suspended.token)));

  console.log("\nCancelling...");
  await cancelScanHandoff(USER, suspended.token);
  check("a cancelled grant is gone", (await findScanHandoff(suspended.token)) === null);

  console.log("\nNo photograph is ever stored...");
  const columns = Object.keys(captureHandoffs);
  const imageish = columns.filter((c) => /image|photo|blob|bytes|base64|data/i.test(c));
  check("the table has no column that could hold pixels", imageish.length === 0, imageish.join(", "));

  await db.delete(captureHandoffs);
  console.log("\nAll scan-handoff checks passed.");
}

run(main);
