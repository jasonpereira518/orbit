/**
 * Count a share of a waitlist pass: copy, native share sheet, LinkedIn, ticket.
 *
 * Until now a share left no trace anywhere server-side (audit D8): the invited-circles count
 * lives in the visitor's own `localStorage`, and a copy was never counted at all. This writes
 * ONE `waitlist_shared` event per call: the signup's id and a channel from a closed list,
 * nothing else. Not the address, not the token, not the link, not an IP.
 *
 * ANONYMOUS BY DESIGN. The caller is a visitor on the waitlist page, not a signed-in user, so
 * the credential is the pass's share token (the same one `?me=` / the progress poll use): it
 * is looked up here and the event carries the ROW'S ID, which is an internal uuid. A token that
 * matches nothing (a bot's fake ticket, a stale link, a rejoined-then-left address) records
 * nothing and says nothing, so the response cannot be used to test tokens.
 *
 * Rate limited per IP (a loop would otherwise inflate the referral-loop numbers) and it never
 * throws: a share control must not be able to fail.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups } from "@/db/schema";
import { ipBucketKey } from "@/lib/client-ip";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { SHARE_CHANNELS } from "@/lib/product-event-schemas";
import { track } from "@/lib/product-events";
import { consumeBucket } from "@/lib/rate-limit";

export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export function isShareChannel(value: unknown): value is ShareChannel {
  return typeof value === "string" && (SHARE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Generous on purpose: a person tries Copy, Messages and LinkedIn in one sitting, and several
 * friends share one NAT. It only stops a script. The scope is a variable, not a literal, because
 * the limiter's error is caught here and never shown, so it needs no user-facing label.
 */
const SHARE_SCOPE: string = "interest.share";
const SHARE_POLICY = { limit: 40, windowSec: 600 } as const;

export async function recordWaitlistShareCore(input: {
  shareToken: unknown;
  channel: unknown;
  ip: string;
}): Promise<boolean> {
  try {
    const token = typeof input.shareToken === "string" ? input.shareToken.trim() : "";
    if (!token || token.length > SHARE_TOKEN_MAX || !isShareChannel(input.channel)) return false;

    try {
      await consumeBucket(SHARE_SCOPE, ipBucketKey(input.ip), SHARE_POLICY);
    } catch {
      // Over the limit, or a limiter that cannot count: record nothing.
      return false;
    }

    const db = await getDb();
    const [row] = await db
      .select({ id: interestListSignups.id })
      .from(interestListSignups)
      .where(and(eq(interestListSignups.shareToken, token), isNull(interestListSignups.unsubscribedAt)))
      .limit(1);
    if (!row) return false;

    track("waitlist_shared", { signup_id: row.id, channel: input.channel });
    return true;
  } catch (err) {
    console.error("[interest-list] share record failed", err);
    return false;
  }
}
