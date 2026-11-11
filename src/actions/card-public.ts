"use server";

import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { reportError } from "@/lib/report-error";
import { shareBackCore, type ShareBackInput, type ShareBackResult } from "@/lib/cards/share-back";

/**
 * A stranger's share-back from a public card. The request-reading half; everything else is
 * in `lib/cards/share-back.ts`. The core rethrows anything it cannot answer (a limiter that
 * cannot count, say); the visitor gets generic copy, never the error's own text.
 */
export async function shareBackToCard(input: ShareBackInput): Promise<ShareBackResult> {
  try {
    return await shareBackCore(input, { ip: clientIpFrom(await headers()) });
  } catch (err) {
    reportError(err, { where: "action.card.shareBack" });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}
