/**
 * The grant that lets a signed-out phone contribute one scan.
 *
 * WHAT THIS GUARDS. This is a public, token-authenticated write path — the only one in the
 * app that accepts user content without a Clerk session — so the interesting cases are all
 * the ways it must refuse. A malformed token must cost zero queries, an expired one must be
 * indistinguishable from a nonexistent one, a suspended account must go quiet, a transcript
 * transcript must land on the minting account's capture job and nowhere else, and a token
 * must never expose that job to another account. Each of those is a silent failure if it
 * regresses: the happy path keeps working and only the refusals stop.
 *
 * It also pins the promise that no photograph is ever stored. The tables hold text.
 *
 * Runs against a throwaway PGlite (see ./smoke/_env).
 * Run: npx tsx scripts/smoke-scan-handoff.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { captureHandoffs, captureJobs, userSettings } from "../src/db/schema";
import {
  HANDOFF_TTL_MS,
  buildScanHandoffUrl,
  cancelScanHandoff,
  findScanHandoff,
  finishScanHandoff,
  generateHandoffToken,
  handoffJobFor,
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

  console.log("\nMinting attaches a capture job...");
  check("the grant carries a job id", Boolean(minted.captureJobId));
  const jobBefore = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, minted.captureJobId) });
  check("the job belongs to the minting account and is collecting", jobBefore?.userId === USER && jobBefore?.status === "ingesting" && jobBefore.sourceKind === "phone");
  check("the row links to it", stored!.captureJobId === minted.captureJobId);

  console.log("\nThe phone uploads...");
  await markHandoffUploading(found!.id);
  const watching = await handoffJobFor(USER, minted.token);
  check("the desktop sees 'uploading' before any text", watching?.status === "uploading", watching?.status);

  await recordHandoffTranscript(found!.id, {
    transcript: "Ada Lovelace — Analytical Engines. Follow up next week.",
    pageCount: 2,
    sources: "photos:2",
  });
  await recordHandoffTranscript(found!.id, { transcript: "Grace Hopper — call before the 20th.", pageCount: 1, sources: "photos:1" });
  const jobAfter = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, minted.captureJobId) });
  check("each batch appends a block to the job, in order", jobAfter?.ingestedBlocks.map((b) => b.text.split(" ")[0]).join(",") === "Ada,Grace", JSON.stringify(jobAfter?.ingestedBlocks));
  check("the job is still collecting — the phone can send more", jobAfter?.status === "ingesting");
  const rowAfter = await db.query.captureHandoffs.findFirst({ where: eq(captureHandoffs.userId, USER) });
  check("the grant counts pages and stays redeemable", rowAfter?.pageCount === 3 && rowAfter.status === "ready");
  check("the row itself holds no transcript", rowAfter?.transcript === null);

  console.log("\nOnly the minting account can see the job...");
  check("another signed-in account gets nothing from the token", (await handoffJobFor(OTHER, minted.token)) === null);
  check("...and the grant is untouched", Boolean(await findScanHandoff(minted.token)));

  console.log("\nFinishing is single-use...");
  const finished = await finishScanHandoff(found!.id);
  check("finish hands back the job", finished.captureJobId === minted.captureJobId);
  const jobDone = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, minted.captureJobId) });
  check("the job is now waiting on Extract", jobDone?.status === "transcribed");
  // The grant must not outlive the handoff.
  check("the grant is deleted", !(await findScanHandoff(minted.token)));
  check("finishing again is harmless", (await finishScanHandoff(found!.id)).captureJobId === null);

  console.log("\nA failed page is reported without burning the grant...");
  const retry = await mintScanHandoff(USER);
  const retryRow = await findScanHandoff(retry.token);
  await recordHandoffError(retryRow!.id, "That photo could not be read.");
  const errored = await handoffJobFor(USER, retry.token);
  check("the desktop is told why", errored?.error?.includes("could not be read") === true, errored?.error ?? "");
  // Walking back to the laptop for a fresh QR code just to retake one photo is a bad trade.
  check("the token still resolves, so the phone can retry", Boolean(await findScanHandoff(retry.token)));
  await cancelScanHandoff(USER, retry.token);
  check("cancelling a grant that never got a page discards its job", (await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, retry.captureJobId) }))?.status === "discarded");

  console.log("\nExpiry is indistinguishable from 'never existed'...");
  const expiring = await mintScanHandoff(USER);
  await db
    .update(captureHandoffs)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(captureHandoffs.tokenHash, hashHandoffToken(expiring.token)));
  check("an expired token does not resolve", (await findScanHandoff(expiring.token)) === null);
  check("and shows the desktop nothing", (await handoffJobFor(USER, expiring.token)) === null);

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
  const columns = [...Object.keys(captureHandoffs), ...Object.keys(captureJobs)];
  // `photoIds` is a list of `capture_photos` ids — references to rows the history route
  // serves with an owner check — not bytes. Anything else image-shaped is a regression.
  const imageish = columns.filter((c) => c !== "photoIds" && /image|photo|blob|bytes|base64|data/i.test(c));
  check("neither table has a column that could hold pixels", imageish.length === 0, imageish.join(", "));

  await db.delete(captureHandoffs);
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  console.log("\nAll scan-handoff checks passed.");
}

run(main);
