import { cookies } from "next/headers";
import {
  ATTRIBUTION_COOKIE,
  LAST_TOUCH_COOKIE,
  parseAttribution,
  parseLastTouch,
} from "@/lib/attribution-parse";
import { attributionPending, recordDirectVisit, recordFirstTouch } from "@/lib/attribution";
import { claimSiteInviteGrant } from "@/lib/site-invites";

/**
 * Move the first-touch (and last-touch) cookies into the account row, once.
 *
 * Called from `(app)/layout.tsx`, which is the first authenticated surface every new user
 * reaches. It cannot go in `bootstrapAuthenticatedUser` — that runs from server actions
 * and route handlers too, and reading `cookies()` outside a request context throws.
 *
 * The cookie is deliberately NOT cleared afterwards. Clearing needs a mutable response,
 * which a layout does not have; and it does not matter, because `recordFirstTouch` filters
 * on `signup_attributed_at IS NULL` in SQL, so every later call is one no-op UPDATE
 * against an indexed key. The cookie expires on its own.
 *
 * An account that arrives with no cookie is marked as a direct visit rather than left
 * null. That distinction is the whole reason `signup_attributed_at` exists: without it,
 * "came here directly" is indistinguishable from "signed up before any of this was built",
 * and the channel rollup silently blends a real segment with a historical gap.
 */
export async function captureAttribution(userId: string): Promise<void> {
  try {
    const store = await cookies();
    const raw = store.get(ATTRIBUTION_COOKIE)?.value ?? null;
    const attribution = parseAttribution(raw);

    if (attribution) {
      // The proxy sets both cookies on the same channel-bearing landing, so a first touch
      // always has a last touch beside it (the same landing, for a one-visit signup).
      const lastTouch = parseLastTouch(store.get(LAST_TOUCH_COOKIE)?.value ?? null);
      await recordFirstTouch(userId, attribution, "cookie", lastTouch);
    } else {
      // No cookie. An invited account's cookie lives on the waitlist host, so this is the
      // normal shape of an invited sign-up, and the waitlist row holds its real channel. The
      // Clerk webhook that links the account to that row can land AFTER this first render, so
      // while the account is still unattributed the link is made here first (one Clerk call,
      // once per account: `attributionPending` is false from then on). It also fills the
      // ledger for a webhook that never arrives.
      if (await attributionPending(userId)) await claimSiteInviteGrant(userId);
      await recordDirectVisit(userId);
    }
  } catch {
    // Attribution is never worth failing a page render over.
  }
}
