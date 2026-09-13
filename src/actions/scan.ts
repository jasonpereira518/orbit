"use server";

import QRCode from "qrcode";
import { requireUserId } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { getCaptureJobRow, toCaptureJobView, type CaptureJobView } from "@/lib/capture-jobs";
import {
  cancelScanHandoff,
  finishScanHandoff,
  handoffJobFor,
  looksLikeHandoffToken,
  mintScanHandoff,
  hashHandoffToken,
} from "@/lib/scan-handoff";
import { getDb } from "@/db";
import { captureHandoffs } from "@/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Desktop-side half of the phone handoff. Every export here is async, because one
 * non-async export in a "use server" file breaks every export in it and tsc cannot see it.
 */

export type MintedScanHandoff = {
  token: string;
  url: string;
  /** Pre-rendered so the QR encoder never reaches the browser bundle. */
  svg: string;
  expiresAtIso: string;
  /** The capture job the phone's pages land on. */
  captureJobId: string;
};

/**
 * Mint a grant and render its QR code.
 *
 * The SVG is produced here rather than in the client because it costs nothing to do so —
 * this is already a round trip — and it keeps an encoder out of a bundle that every
 * signed-in user downloads for a feature most of them will not use today. `currentColor`
 * lets the mark inherit the card's text color, so it themes itself in dark mode.
 */
export async function mintScanHandoffAction() {
  try {
    const userId = await requireUserId();
    const minted = await mintScanHandoff(userId);

    const svg = await QRCode.toString(minted.url, {
      type: "svg",
      // "M" tolerates ~15% damage. Higher correction means a denser grid, which is harder
      // for a phone to resolve across a desk — and this code is read off a clean screen at
      // arm's length, not printed on a box.
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#000000", light: "#0000" },
    });

    return {
      ok: true as const,
      handoff: {
        token: minted.token,
        url: minted.url,
        // The generated markup hard-codes black; recolor it so the code follows the theme
        // instead of vanishing into a dark card.
        svg: svg.replace(/#000000/g, "currentColor"),
        expiresAtIso: minted.expiresAt.toISOString(),
        captureJobId: minted.captureJobId,
      } satisfies MintedScanHandoff,
    };
  } catch (err) {
    return { ok: false as const, error: friendlyError(err, "Couldn’t make a QR code — try again?") };
  }
}

export type HandoffWatch =
  | { state: "expired" }
  | { state: "waiting" | "uploading" | "ready" | "done"; pages: number; error: string | null; job: CaptureJobView | null };

/**
 * Desktop poll: what the phone has done so far. The text lives on the job; this reports
 * the grant's state and the job's blocks. `done` means the phone pressed Done — the grant
 * is gone and the job is `transcribed`.
 */
export async function watchScanHandoffAction(token: string, captureJobId: string): Promise<{ ok: true; watch: HandoffWatch } | { ok: false; error: string }> {
  try {
    const userId = await requireUserId();
    const row = await getCaptureJobRow(userId, captureJobId);
    const job = row ? toCaptureJobView(row) : null;
    const grant = await handoffJobFor(userId, token);
    if (!grant) {
      if (job && job.status === "transcribed") return { ok: true, watch: { state: "done", pages: job.blocks.length, error: null, job } };
      return { ok: true, watch: { state: "expired" } };
    }
    const pages = job?.blocks.length ?? 0;
    const state = grant.status === "uploading" ? "uploading" : pages > 0 ? "ready" : "waiting";
    return { ok: true, watch: { state, pages, error: grant.error, job } };
  } catch (err) {
    return { ok: false as const, error: friendlyError(err, "Couldn’t check on your phone — try again?") };
  }
}

/** The desktop says it has everything: consume the grant and hand the job to Extract. */
export async function finishScanHandoffAction(token: string) {
  try {
    const userId = await requireUserId();
    if (!looksLikeHandoffToken(token)) return { ok: false as const, error: "That code expired" };
    const db = await getDb();
    const row = await db.query.captureHandoffs.findFirst({
      where: and(eq(captureHandoffs.tokenHash, hashHandoffToken(token)), eq(captureHandoffs.userId, userId)),
    });
    if (!row) return { ok: false as const, error: "That code expired" };
    const out = await finishScanHandoff(row.id);
    const job = out.captureJobId ? await getCaptureJobRow(userId, out.captureJobId) : null;
    return { ok: true as const, job: job ? toCaptureJobView(job) : null };
  } catch (err) {
    return { ok: false as const, error: friendlyError(err, "Couldn’t finish that scan — try again?") };
  }
}

/** Drop a grant the person closed the QR card on, so a stale code cannot be redeemed. */
export async function cancelScanHandoffAction(token: string) {
  try {
    const userId = await requireUserId();
    await cancelScanHandoff(userId, token);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: friendlyError(err, "Couldn’t cancel that code — try again?") };
  }
}
