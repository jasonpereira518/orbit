import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { deterministicEventId } from "@/lib/product-event-ids";
import { track } from "@/lib/product-events";

/**
 * Close the anonymous-session -> account link, without a cookie.
 *
 * The page-view beacon already holds a per-tab session id (`pv_sid`). The first time the
 * beacon route sees a SIGNED-IN view for an account that has no `signup_session_id`, that id
 * is written to the account and `first_app_load` is emitted: "this account's first session
 * landed on /pricing from Reddit" becomes a join on `session_id`, with no new identifier and
 * nothing stored about an anonymous visitor (TRACKING_PLAN §3.2).
 *
 * WRITE-ONCE IN SQL. `signup_session_id IS NULL` is in the WHERE clause, so two concurrent
 * beacons cannot both claim it, and a later session never overwrites it. The returned row is
 * what makes the event fire exactly once; the event id is also deterministic, so a retry is
 * the same event.
 *
 * ONLY FOR NEW ACCOUNTS. An account older than {@link SIGNUP_SESSION_WINDOW} was created
 * before this existed (or long before this view); its "signup session" is unknowable, and
 * recording the first beacon after the deploy as one would be a false fact. Their column
 * stays null.
 *
 * CHEAP: one UPDATE that matches nothing for everyone already linked, and a per-instance set
 * of accounts known to be done so the steady state is no query at all.
 */
export const SIGNUP_SESSION_WINDOW = "2 days";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ROUTE = /^\/[a-z0-9\-/[\].]*$/;

/** Accounts this instance has seen linked or ineligible. Bounded: cleared when it grows. */
const done = new Set<string>();
const DONE_MAX = 5000;

function remember(userId: string) {
  if (done.size >= DONE_MAX) done.clear();
  done.add(userId);
}

/** Test seam: forget what this instance has already handled. */
export function resetSignupSessionCache() {
  done.clear();
}

/**
 * Returns true when this call linked the session (and so emitted `first_app_load`).
 * Never throws: it runs inside a beacon that must always answer 204.
 */
export async function linkSignupSession(input: {
  userId: string;
  sessionId: string;
  /** The stored route PATTERN of the view, never a pathname. */
  route: string;
}): Promise<boolean> {
  const { userId, sessionId } = input;
  if (userId === "demo-user" || !SESSION_ID.test(sessionId) || done.has(userId)) return false;

  const db = await getDb();
  const claimed = await db
    .update(userSettings)
    .set({ signupSessionId: sessionId })
    .where(
      and(
        eq(userSettings.userId, userId),
        isNull(userSettings.signupSessionId),
        sql`${userSettings.createdAt} > now() - interval '${sql.raw(SIGNUP_SESSION_WINDOW)}'`
      )
    )
    .returning();

  if (claimed.length === 0) {
    // Nothing to claim. Remember it only when the row exists and is settled (already linked,
    // or too old to ever be): a row that does not exist YET is the very first view racing the
    // account's bootstrap, and the next beacon should try again.
    const [row] = await db
      .select({ createdAt: userSettings.createdAt, sessionId: userSettings.signupSessionId })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (row && (row.sessionId || Date.now() - row.createdAt.getTime() > 2 * 86_400_000)) remember(userId);
    return false;
  }

  remember(userId);
  track(
    "first_app_load",
    { session_id: sessionId, landing_route: EVENT_ROUTE.test(input.route) ? input.route : "/" },
    { userId, sessionId, id: deterministicEventId("first_app_load", userId) }
  );
  return true;
}
