"use server";

import QRCode from "qrcode";
import { requireUserId } from "@/lib/auth";
import { toUserFacingError } from "@/lib/errors";
import {
  cancelScanHandoff,
  claimScanHandoff,
  mintScanHandoff,
  type HandoffClaim,
} from "@/lib/scan-handoff";

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
      } satisfies MintedScanHandoff,
    };
  } catch (err) {
    return { ok: false as const, error: toUserFacingError(err).message };
  }
}

/** Desktop poll. A `ready` result consumes the grant — see `claimScanHandoff`. */
export async function pollScanHandoffAction(token: string) {
  try {
    const userId = await requireUserId();
    const claim: HandoffClaim = await claimScanHandoff(userId, token);
    return { ok: true as const, claim };
  } catch (err) {
    return { ok: false as const, error: toUserFacingError(err).message };
  }
}

/** Drop a grant the person closed the QR card on, so a stale code cannot be redeemed. */
export async function cancelScanHandoffAction(token: string) {
  try {
    const userId = await requireUserId();
    await cancelScanHandoff(userId, token);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: toUserFacingError(err).message };
  }
}
